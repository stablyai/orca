import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { getFollowUpDispatch } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../../../../../shared/orchestration-worker-start-prompt-budget'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../../../../shared/agent-session-provider-context'
import { HOST_TEST_THREAD } from '../../../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { receipt, useHelperFollowUpCli } from './helper-follow-up-cli.test-support'
import {
  seedUnrelatedHistory,
  traceCallerReads,
  traceDispatchProbes
} from './helper-follow-up-sql-trace.test-support'

describe('helper follow-ups through CLI argv, RPC and SQLite', () => {
  const f = useHelperFollowUpCli()
  /** The send's RPC handler's refusal, as its runtime raises it. */
  async function handlerRefusal(params: Record<string, unknown>) {
    try {
      await f.h.call('orchestration.send', params)
    } catch (error) {
      if (error instanceof OrchestrationError) {
        return { error: { code: error.code, message: error.message, data: error.data } }
      }
      throw error
    }
    return { error: undefined }
  }
  const depthOf = (dispatch: { dispatchId: string }) =>
    f.h.db.getDispatchContextById(dispatch.dispatchId)!.depth
  const {
    h,
    panes,
    cli,
    success,
    start,
    report,
    pair,
    follow,
    takeOver,
    continues,
    placeNextWorkerInChat,
    otherRun,
    effects
  } = f

  it.each(['term_worker', 'term_coord'] as const)(
    'lets %s continue a finished helper in place twice using the original address',
    async (from) => {
      const { worker, helper } = await pair()
      const resource = h.db.getWorkerTerminalResourceByOwner(helper.dispatchId)!
      for (let turn = 0; turn < 2; turn++) {
        const sent = await follow(from, helper.dispatchId)
        expect(sent.error).toBeUndefined()
        expect(sent.result).toMatchObject({ delivery: 'follow_up', state: 'ready' })
        const continued = receipt.parse(sent.result)
        if (from === 'term_worker') {
          expect(h.db.getDispatchContextById(continued.dispatchId)?.creator_dispatch_id).toBe(
            worker.dispatchId
          )
          expect(h.db.getTask(continued.taskId)?.parent_id).toBe(worker.taskId)
        }
        expect(h.db.getWorkerTerminalResourceByOwner(continued.dispatchId)).toMatchObject({
          id: resource.id,
          origin_dispatch_id: helper.dispatchId,
          ownership_state: 'owned',
          terminal_handle: 'term_helper'
        })
        expect(h.runtime.createTerminal).toHaveBeenCalledTimes(2)
        await report(
          'term_helper',
          continued,
          from === 'term_worker' ? `dispatch:${worker.dispatchId}` : 'term_coord'
        )
      }
    }
  )

  it.each(['creator settled', 'depth already exceeded'] as const)(
    'refuses before closing a leftover shell when the %s',
    async (refusal) => {
      const { worker, helper } = await pair()
      const gate = h.deferred<void>()
      const entered = h.deferred<void>()
      vi.mocked(h.runtime.isTerminalRunningAgent).mockImplementation(async () => {
        entered.resolve()
        await gate.promise
        return false
      })
      if (refusal === 'depth already exceeded') {
        vi.mocked(h.runtime.getNestedWorkerMaxDepth).mockReturnValue(depthOf(worker))
        gate.resolve()
      }
      let before = effects()
      const pending = follow('term_worker', helper.dispatchId)
      if (refusal === 'creator settled') {
        await entered.promise
        h.settle(worker.taskId, worker.dispatchId, 'succeeded')
        before = effects()
        gate.resolve()
      }
      const { error } = await pending
      expect(error).toMatchObject({
        code: refusal === 'creator settled' ? 'consumer_fenced' : 'nested_worker_depth_exceeded',
        data: { effectsApplied: false }
      })
      expect(effects()).toEqual(before)
      expect(getFollowUpDispatch(h.db, helper.dispatchId)).toBeUndefined()
    }
  )

  it.each([
    'creator settled',
    'depth lowered',
    'assembled spec too large',
    'no agent to start'
  ] as const)(
    'says the leftover shell was closed when a later check refuses: %s',
    async (refusal) => {
      const { worker, helper } = await pair()
      vi.mocked(h.runtime.isTerminalRunningAgent).mockResolvedValue(false)
      let body = 'also check the result'
      if (refusal === 'creator settled') {
        // The second workspace read is the start's own preflight, after placement closed the shell.
        const show = vi.mocked(h.runtime.showManagedTerminalWorkspace).getMockImplementation()!
        let reads = 0
        vi.mocked(h.runtime.showManagedTerminalWorkspace).mockImplementation(async (...args) => {
          if (++reads === 2) {
            h.settle(worker.taskId, worker.dispatchId, 'succeeded')
          }
          return show(...args)
        })
      }
      if (refusal === 'depth lowered') {
        vi.mocked(h.runtime.getNestedWorkerMaxDepth)
          .mockReturnValueOnce(6)
          .mockReturnValue(depthOf(worker))
      }
      if (refusal.endsWith('spec too large')) {
        body = 'x'.repeat(ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES - 1)
      }
      if (refusal === 'no agent to start') {
        h.db.db
          .prepare(
            "UPDATE worker_dispatches SET start_options = json_remove(start_options, '$.agent') WHERE dispatch_id = ?"
          )
          .run(helper.dispatchId)
      }
      const before = effects()
      // The local CLI cannot carry these two refusals today: a body this large exceeds the socket's frame limit, and
      // the RPC boundary does not pass worker_not_restartable through. The send's own handler still refuses them.
      const { error } =
        refusal === 'creator settled' || refusal === 'depth lowered'
          ? await follow('term_worker', helper.dispatchId, body)
          : await handlerRefusal({
              from: 'term_worker',
              to: `dispatch:${helper.dispatchId}`,
              subject: 'More',
              body
            })
      expect(error).toMatchObject({
        code: {
          'creator settled': 'consumer_fenced',
          'depth lowered': 'nested_worker_depth_exceeded',
          'assembled spec too large': 'worker_prompt_too_large',
          'no agent to start': 'worker_not_restartable'
        }[refusal],
        message: expect.stringContaining(
          `Orca had already asked to close the shell Dispatch ${helper.dispatchId}'s finished agent left behind.`
        ),
        data: { effectsApplied: true }
      })
      expect(error?.message).not.toMatch(/effects were applied/)
      expect(h.db.getWorkerTerminalResourceByOwner(helper.dispatchId)?.release_state).toBe(
        'released'
      )
      expect(effects()).toMatchObject({
        tasks: before.tasks,
        dispatches: before.dispatches,
        closes: before.closes + 1
      })
      expect(getFollowUpDispatch(h.db, helper.dispatchId)).toBeUndefined()
    }
  )

  it.each([true, false])(
    'continues an own structured helper with its chat visible=%s',
    async (visible) => {
      const worker = await start('term_coord', 'term_worker')
      const { current, identity, sessionId } = await placeNextWorkerInChat()
      let providerTurn = ''
      async function acceptChat<T>(operation: Promise<T>): Promise<T> {
        const pending = operation.then(
          (value) => ({ value }),
          (error: unknown) => ({ error })
        )
        await vi.waitFor(() => expect(current.dispatch).toHaveBeenCalled())
        const command = current.dispatch.mock.lastCall![0]
        const itemId = randomUUID()
        providerTurn = `turn-${itemId}`
        await current.settleAccepted(command.clientMessageId, itemId)
        const settled = await pending
        if ('error' in settled) {
          throw settled.error
        }
        return settled.value
      }
      const helper = await acceptChat(start('term_worker', identity.handle))
      await report(identity.handle, helper, `dispatch:${worker.dispatchId}`)
      const threadId =
        activeProviderContext(current.store.getRecord(sessionId)!).head?.handle.nativeId ??
        HOST_TEST_THREAD
      current
        .providerEvents()
        .appendItem(
          { provider: 'codex', threadId, turnId: providerTurn, ordinal: 1 },
          { kind: 'turn', turnId: providerTurn, state: 'completed', startedAt: 1 },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
      await current.host.flushStreamedEvents(sessionId)
      expect(current.host.currentWork(sessionId)?.working()).toBe(false)
      current.dispatch.mockClear()
      vi.spyOn(current.host, 'isSessionTabVisible').mockReturnValue(visible)
      const sent = await acceptChat(follow('term_worker', helper.dispatchId))
      expect(sent.error).toBeUndefined()
      expect(sent.result).toMatchObject({
        state: 'ready',
        delivery: visible ? 'follow_up' : 'reopened'
      })
      const continued = receipt.parse(sent.result)
      expect(h.db.getDispatchContextById(continued.dispatchId)?.creator_dispatch_id).toBe(
        worker.dispatchId
      )
      expect(h.db.getWorkerTerminalResourceByOwner(continued.dispatchId)?.terminal_handle).toBe(
        identity.handle
      )
      expect(h.runtime.createTerminal).toHaveBeenCalledTimes(1)
      expect(current.host.isSessionTabVisible).toHaveBeenCalled()
    }
  )

  it.each(['reopened', 'started_fresh'] as const)(
    'continues an own closed helper with %s',
    async (delivery) => {
      const { helper } = await pair()
      if (delivery === 'reopened') {
        vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
          paneKey: panes.get('term_helper')!,
          agent: 'claude',
          processIncarnation: 'process:term_helper',
          providerSession: { key: 'session_id', id: 'fixture-conversation' },
          observedAt: 1
        })
        vi.spyOn(h.runtime, 'resumeAgentSessionInWorkspace').mockResolvedValue({
          ok: true,
          handle: 'term_reopened',
          paneKey: h.runtime.getTerminalPaneKey('term_reopened')!,
          ptyId: 'pty:term_reopened'
        })
      }
      await success('worker-release', '--dispatch', helper.dispatchId)
      f.nextTerminal = 'term_fresh'
      const sent = await follow('term_worker', helper.dispatchId)
      expect(sent.error).toBeUndefined()
      expect(sent.result).toMatchObject({ delivery, state: 'ready' })
      if (delivery === 'reopened') {
        expect(h.runtime.resumeAgentSessionInWorkspace).toHaveBeenCalledOnce()
      }
    }
  )

  it.each(['live', 'closed', 'leftover'] as const)(
    'refuses another worker’s %s helper before effects',
    async (state) => {
      const worker = await start('term_coord', 'term_worker')
      const other = await start('term_coord', 'term_other')
      const foreign = await start('term_other', 'term_foreign')
      await report('term_foreign', foreign, `dispatch:${other.dispatchId}`)
      if (state === 'closed') {
        await success('worker-release', '--dispatch', foreign.dispatchId)
      }
      if (state === 'leftover') {
        vi.mocked(h.runtime.isTerminalRunningAgent).mockResolvedValue(false)
      }
      const before = effects()
      // The CLI adds its own request ID and recovery command after the runtime's refusal.
      expect((await follow('term_worker', foreign.dispatchId)).error).toMatchObject({
        code: 'task_not_found',
        message: expect.stringMatching(
          `^Dispatch ${foreign.dispatchId} is not a helper of Dispatch ${worker.dispatchId}, so only the coordinator or the worker that started it can give it more work; to hand this to a helper, start new helper work with worker-start --spec\\. No effects were applied\\.`
        ),
        data: { effectsApplied: false }
      })
      expect(effects()).toEqual(before)
      expect(getFollowUpDispatch(h.db, foreign.dispatchId)).toBeUndefined()
    }
  )

  it('refuses coordinator work, cross-Run coordinators and unattached callers before cleanup', async () => {
    const target = await start('term_coord', 'term_target')
    await report('term_target', target, 'term_coord')
    await start('term_coord', 'term_worker')
    otherRun()
    vi.mocked(h.runtime.isTerminalRunningAgent).mockResolvedValue(false)
    const refusals = {
      // Coordinator work has no worker creator, so it is no worker's helper.
      term_worker: 'is not a helper of Dispatch',
      term_other_coord: 'This caller coordinates Run',
      term_unattached: 'worker-start needs the coordinator bound to the Run'
    }
    for (const [from, message] of Object.entries(refusals)) {
      const before = effects()
      expect((await follow(from, target.dispatchId)).error).toMatchObject({
        code: from === 'term_worker' ? 'task_not_found' : 'consumer_fenced',
        message: expect.stringContaining(message)
      })
      expect(effects()).toEqual(before)
    }
  })

  it.each(['terminal', 'on'] as const)('still refuses a worker’s explicit --%s', async (flag) => {
    const { helper } = await pair()
    const before = effects()
    const sent = await cli(
      'worker-start',
      '--from',
      'term_worker',
      '--spec',
      'next',
      `--${flag}`,
      flag === 'terminal' ? 'term_helper' : 'other-host'
    )
    expect(sent.error).toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('omit --on and --terminal')
    })
    expect(effects()).toEqual(before)
    expect(getFollowUpDispatch(h.db, helper.dispatchId)).toBeUndefined()
  })

  it.each(['own', 'foreign'] as const)(
    'continues held mail after a helper reports only from its %s creator',
    async (sender) => {
      const worker = await start('term_coord', 'term_worker')
      const owner = sender === 'own' ? worker : await start('term_coord', 'term_other')
      const helper = await start(sender === 'own' ? 'term_worker' : 'term_other', 'term_helper')
      expect((await follow('term_worker', helper.dispatchId)).error).toBeUndefined()
      const before = effects()
      await report('term_helper', helper, `dispatch:${owner.dispatchId}`)
      const notices = () =>
        h.db.db
          .prepare(
            "SELECT body FROM messages WHERE subject = 'Mail did not reach the finished worker'"
          )
          .all()
      if (sender === 'own') {
        await vi.waitFor(() => expect(getFollowUpDispatch(h.db, helper.dispatchId)).toBeDefined())
        const next = getFollowUpDispatch(h.db, helper.dispatchId)!
        expect(next.creator_dispatch_id).toBe(worker.dispatchId)
        expect(h.db.getWorkerTerminalResourceByOwner(next.id)?.terminal_handle).toBe('term_helper')
        expect(notices()).toEqual([])
        return
      }
      await vi.waitFor(() => expect(notices()).toHaveLength(1))
      expect(notices()[0]).toMatchObject({
        body: expect.stringContaining(
          `Dispatch ${helper.dispatchId} is not a helper of Dispatch ${worker.dispatchId}`
        )
      })
      expect(h.db.getUnreadMessages(`dispatch:${helper.dispatchId}`)).toHaveLength(1)
      expect(getFollowUpDispatch(h.db, helper.dispatchId)).toBeUndefined()
      expect(effects().closes).toBe(before.closes)
    }
  )

  it('reads the same custody evidence for a chain of recoveries however much unrelated work is stored', async () => {
    const counts: unknown[] = []
    const traces: ReturnType<typeof traceCallerReads>[] = []
    for (const unrelated of [40, 400]) {
      const terminal = `term_worker_${unrelated}`
      const first = await start('term_coord', terminal)
      const helper = await start(terminal, `${terminal}_helper`)
      await report(`${terminal}_helper`, helper, `dispatch:${first.dispatchId}`)
      await report(terminal, first, 'term_coord')
      // Four recoveries of the same agent; only the last is still at work.
      let caller = first
      for (let step = 0; step < 4; step++) {
        caller = await takeOver('term_coord', terminal)
        if (step < 3) {
          await report(terminal, caller, 'term_coord')
        }
      }
      const { process_incarnation: incarnation, host_scope: host } = h.db.getDispatchContextById(
        first.dispatchId
      )!
      seedUnrelatedHistory(h.db, h.activeRunId, unrelated, {
        pane: h.runtime.getTerminalPaneKey(terminal)!,
        incarnation: incarnation!,
        host
      })
      const trace = traceCallerReads(h.db)
      await continues(terminal, helper, caller)
      counts.push(trace.counts())
      traces.push(trace)
      trace.restore()
    }
    // One indexed read of the agent's custody, visiting its one row, at both sizes; no former-owner scan.
    expect(counts[0]).toMatchObject({
      identity: { executions: 1, visited: 1 },
      formerOwner: { executions: 0, visited: 0 }
    })
    expect(counts[1]).toEqual(counts[0])
    for (const trace of traces) {
      expect(trace.expectIndexedPlans()).toEqual(['identity'])
    }
  })

  it('reads custody once per row however long the follow-up chain and however many rows share its process', async () => {
    const probed: ReturnType<ReturnType<typeof traceDispatchProbes>['counts']>[] = []
    for (const length of [3, 30]) {
      const sender = `term_sender_${length}`
      const child = `term_child_${length}`
      let worker = await start('term_coord', sender)
      const helper = await start(sender, child)
      await report(child, helper, `dispatch:${worker.dispatchId}`)
      await success('worker-release', '--dispatch', helper.dispatchId)
      // Each in-place follow-up also takes over the same pane, so every ancestor is found only through its process.
      for (let step = 0; step < length; step++) {
        await report(sender, worker, 'term_coord')
        worker = receipt.parse((await follow('term_coord', worker.dispatchId)).result)
      }
      const { process_incarnation: incarnation, host_scope: host } = h.db.getDispatchContextById(
        worker.dispatchId
      )!
      // As many other custody rows on the chain's exact process as the chain has ancestors.
      const near = { pane: h.runtime.getTerminalPaneKey(sender)!, incarnation: incarnation!, host }
      seedUnrelatedHistory(h.db, h.activeRunId, 4 * length, near, host)
      const trace = traceCallerReads(h.db)
      const probes = traceDispatchProbes(h.db)
      f.nextTerminal = `${child}_continued`
      expect((await follow(sender, helper.dispatchId)).error).toBeUndefined()
      const { identity, formerOwner } = trace.counts()
      // One indexed read of the process's rows, each read a bounded number of times: linear, not ancestors x rows.
      expect(identity).toMatchObject({ executions: 1, visited: length + 1 })
      expect(identity.fieldReads).toBeLessThanOrEqual(4 * (2 * length + 1))
      expect(formerOwner.executions).toBe(0)
      probed.push(probes.counts())
      probes.restore()
      trace.restore()
    }
    // Each further ancestor costs one Dispatch read and one owner probe, and no Dispatch is read more often.
    expect(probed[1]).toEqual({
      total: probed[0].total + 2 * 27,
      perDispatch: probed[0].perDispatch
    })
  })
})
