import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { getFollowUpDispatch } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../../../../../shared/orchestration-worker-start-prompt-budget'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../../../../shared/agent-session-provider-context'
import { HOST_TEST_THREAD } from '../../../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { receipt, useHelperFollowUpCli } from './helper-follow-up-cli.test-support'

describe('helper follow-ups through CLI argv, RPC and SQLite', () => {
  const f = useHelperFollowUpCli()
  const {
    h,
    panes,
    cli,
    success,
    start,
    report,
    pair,
    follow,
    continues,
    placeNextWorkerInChat,
    otherRun,
    depthOf,
    effects
  } = f

  it('lets a worker continue its finished helper in place twice using the original address', async () => {
    const { worker, helper } = await pair()
    const resource = h.db.getWorkerTerminalResourceByOwner(helper.dispatchId)!
    for (let turn = 0; turn < 2; turn++) {
      const sent = await follow('term_worker', helper.dispatchId)
      expect(sent.error).toBeUndefined()
      expect(sent.result).toMatchObject({ delivery: 'follow_up', state: 'ready' })
      const continued = receipt.parse(sent.result)
      expect(h.db.getDispatchContextById(continued.dispatchId)).toMatchObject({
        creator_dispatch_id: worker.dispatchId
      })
      expect(h.db.getTask(continued.taskId)?.parent_id).toBe(worker.taskId)
      expect(h.db.getWorkerTerminalResourceByOwner(continued.dispatchId)).toMatchObject({
        id: resource.id,
        origin_dispatch_id: helper.dispatchId,
        ownership_state: 'owned',
        terminal_handle: 'term_helper'
      })
      expect(h.runtime.createTerminal).toHaveBeenCalledTimes(2)
      await report('term_helper', continued, `dispatch:${worker.dispatchId}`)
    }
  })

  it('keeps coordinator sends working in the same pane', async () => {
    const { helper } = await pair()
    const sent = await follow('term_coord', helper.dispatchId)
    expect(sent.error).toBeUndefined()
    expect(sent.result).toMatchObject({ delivery: 'follow_up', state: 'ready' })
    expect(h.runtime.createTerminal).toHaveBeenCalledTimes(2)
  })

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
    'coordinator spec too large',
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
      const { error } = await follow(
        refusal === 'coordinator spec too large' ? 'term_coord' : 'term_worker',
        helper.dispatchId,
        body
      )
      expect(error).toMatchObject({
        code: {
          'creator settled': 'consumer_fenced',
          'depth lowered': 'nested_worker_depth_exceeded',
          'assembled spec too large': 'worker_prompt_too_large',
          'coordinator spec too large': 'worker_prompt_too_large',
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
          observedAt: Date.now()
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
      expect((await follow('term_worker', foreign.dispatchId)).error).toEqual({
        code: 'task_not_found',
        message: `Dispatch ${foreign.dispatchId} is not a helper of Dispatch ${worker.dispatchId}, so only the coordinator or the worker that started it can give it more work; to hand this to a helper, start new helper work with worker-start --spec. No effects were applied.`,
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
    for (const from of ['term_worker', 'term_other_coord', 'term_unattached']) {
      const before = effects()
      expect((await follow(from, target.dispatchId)).error).toBeDefined()
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

  it('keeps a continued worker’s own helpers and reports their next work to its current Dispatch', async () => {
    const { worker, helper } = await pair()
    await success('worker-release', '--dispatch', helper.dispatchId)
    await report('term_worker', worker, 'term_coord')
    const continuedWorker = receipt.parse((await follow('term_coord', worker.dispatchId)).result)
    f.nextTerminal = 'term_helper_again'
    const continuedHelper = await continues('term_worker', helper, continuedWorker)
    await report('term_helper_again', continuedHelper, `dispatch:${continuedWorker.dispatchId}`)
    expect(h.db.getUnreadMessages(`dispatch:${continuedWorker.dispatchId}`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
    )
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

  it('bounds ownership reads by sender ancestry at N and 10N', async () => {
    const counts: number[] = []
    for (const depth of [3, 30]) {
      const sender = `term_sender_${depth}`
      const child = `term_child_${depth}`
      let worker = await start('term_coord', sender)
      const helper = await start(sender, child)
      await report(child, helper, `dispatch:${worker.dispatchId}`)
      await success('worker-release', '--dispatch', helper.dispatchId)
      // Each in-place follow-up is also a takeover of the same pane, so both kinds of ancestry grow.
      for (let step = 0; step < depth; step++) {
        await report(sender, worker, 'term_coord')
        worker = receipt.parse((await follow('term_coord', worker.dispatchId)).result)
      }
      const reads = [
        vi.spyOn(h.db, 'getDispatchContextById'),
        vi.spyOn(h.db, 'getWorkerTerminalResourceByOwner'),
        vi.spyOn(h.db, 'getWorkerTerminalResourceFormerlyOwnedBy')
      ]
      f.nextTerminal = `${child}_continued`
      expect((await follow(sender, helper.dispatchId)).error).toBeUndefined()
      const total = reads.reduce((sum, read) => sum + read.mock.calls.length, 0)
      counts.push(total)
      expect(total).toBeLessThanOrEqual(3 * depth + 60)
      for (const read of reads) {
        read.mockRestore()
      }
    }
    expect(counts[1] - counts[0]).toBeLessThanOrEqual(3 * (30 - 3))
  })
})
