import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type * as CliRuntimeClient from '../../../../../../cli/runtime-client'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
import { getFollowUpDispatch } from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from '../../../../../native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../../../structured-worker-identity'
import { testOrcaSessionId } from '../../../../../../shared/orca-session-address-test-fixture'
import * as placement from './worker-start-agent-placement'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../../../../../shared/orchestration-worker-start-prompt-budget'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../../../../shared/agent-session-provider-context'
import { HOST_TEST_THREAD } from '../../../../../native-chat/agent-session-wire/structured-agent-session-host-test-data'

const receipt = z.object({ taskId: z.string(), dispatchId: z.string(), state: z.literal('ready') })
const failure = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional()
  })
})

describe('helper follow-ups through CLI argv, RPC and SQLite', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  const output = vi.fn<(value: { result: unknown }) => void>()
  const panes = new Map<string, string>()
  let main: (argv: string[]) => Promise<void>
  let logs: ReturnType<typeof vi.spyOn<typeof console, 'log'>>
  let nextTerminal = 'term_worker'
  let rig: QueuedMessageTestRig | undefined
  let structuredHandle: string | undefined

  beforeEach(async () => {
    h.setup()
    panes.clear()
    for (const name of [
      'ORCA_AGENT_SESSION_ID',
      'ORCA_TERMINAL_HANDLE',
      'ORCA_PANE_KEY',
      'ORCA_PAIRING_CODE',
      'ORCA_ENVIRONMENT'
    ]) {
      vi.stubEnv(name, '')
    }
    const pane = (handle: string) => {
      const structured = structuredWorkerIdentities.get(handle)
      if (structured) {
        return structured.paneKey
      }
      if (!panes.has(handle)) {
        panes.set(handle, `tab_${handle}:${randomUUID()}`)
      }
      return panes.get(handle)!
    }
    // The fixture coordinator must keep the identity bound by setup.
    panes.set('term_coord', h.coordinatorPaneKey)
    vi.mocked(h.runtime.getTerminalPaneKey).mockImplementation(pane)
    vi.mocked(h.runtime.getTerminalProcessIncarnation).mockImplementation(
      (handle) => structuredWorkerIdentities.get(handle)?.processIncarnation ?? `process:${handle}`
    )
    vi.mocked(h.runtime.getOrchestrationDispatchAuthority).mockImplementation((handle) => ({
      runtimeId: h.runtime.getRuntimeId(),
      terminalHandle: handle,
      ptyId: `pty:${handle}`,
      worktreeId: 'repo::worktree',
      paneKey: pane(handle),
      processIncarnation: `process:${handle}`,
      launchTokenHash: null,
      hostScope: { kind: 'local', hostId: 'local' },
      ...structuredWorkerIdentities.get(handle)
    }))
    vi.spyOn(h.runtime, 'getNestedWorkerMaxDepth').mockReturnValue(6)
    vi.mocked(h.runtime.createTerminal).mockImplementation(async () => ({
      handle: nextTerminal,
      worktreeId: 'repo::worktree',
      title: nextTerminal
    }))
    vi.doMock('../../../../../../cli/runtime-client', async (original) => {
      const actual = await original<typeof CliRuntimeClient>()
      return {
        ...actual,
        RuntimeClient: function () {
          return {
            isRemote: false,
            async call(method: string, params: unknown) {
              const parsed = z.record(z.string(), z.unknown()).parse(params)
              if (method === 'terminal.resolveIdentity') {
                return { result: { identity: { handle: parsed.terminal, live: true } } }
              }
              try {
                return { result: await h.call(method, parsed) }
              } catch (error) {
                if (error instanceof OrchestrationError) {
                  throw new actual.RuntimeClientError(error.code, error.message, error.data)
                }
                throw error
              }
            }
          }
        }
      }
    })
    vi.doMock('../../../../../../cli/format', () => ({ printResult: output }))
    logs = vi.spyOn(console, 'log').mockImplementation(() => {})
    const cliPath = '../../../../../../cli/index'
    main = (await import(cliPath)).main
  })

  afterEach(async () => {
    setStructuredAgentSessionHost(null)
    if (structuredHandle) {
      structuredWorkerIdentities.forget(structuredHandle)
    }
    structuredHandle = undefined
    await rig?.dispose()
    rig = undefined
    getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
    h.cleanup()
    vi.doUnmock('../../../../../../cli/runtime-client')
    vi.doUnmock('../../../../../../cli/format')
    vi.unstubAllEnvs()
    vi.resetModules()
    process.exitCode = 0
  })

  async function cli(...args: string[]) {
    output.mockClear()
    logs.mockClear()
    process.exitCode = 0
    await main(['orchestration', ...args, '--json', '--full'])
    const printed = output.mock.lastCall?.[0]
    const lastLog = logs.mock.lastCall?.[0]
    const error = typeof lastLog === 'string' ? failure.safeParse(JSON.parse(lastLog)) : undefined
    return { result: printed?.result, error: error?.success ? error.data.error : undefined }
  }

  async function success(...args: string[]) {
    const result = await cli(...args)
    expect(result.error).toBeUndefined()
    expect(process.exitCode, JSON.stringify(result)).toBe(0)
    return result.result
  }

  async function start(from: string, handle: string) {
    nextTerminal = handle
    return receipt.parse(
      await success(
        'worker-start',
        '--from',
        from,
        '--spec',
        `work by ${handle}`,
        '--agent',
        'codex'
      )
    )
  }

  async function report(from: string, task: z.infer<typeof receipt>, to: string) {
    await success(
      'send',
      '--from',
      from,
      '--to',
      to,
      '--subject',
      'Done',
      '--type',
      'worker_done',
      '--payload',
      JSON.stringify({
        taskId: task.taskId,
        dispatchId: task.dispatchId,
        outcome: 'succeeded'
      })
    )
    expect(h.db.getDispatchContextById(task.dispatchId)?.status).toBe('completed')
  }

  async function pair() {
    const worker = await start('term_coord', 'term_worker')
    const helper = await start('term_worker', 'term_helper')
    await report('term_helper', helper, `dispatch:${worker.dispatchId}`)
    return { worker, helper }
  }

  const follow = (from: string, id: string, body = 'also check the result') =>
    cli('send', '--from', from, '--to', `dispatch:${id}`, '--subject', 'More', '--body', body)

  /** A coordinator starts new work on the exact agent a settled worker left running. */
  async function takeOver(from: string, terminal: string) {
    return receipt.parse(
      await success('worker-start', '--from', from, '--spec', 'next step', '--terminal', terminal)
    )
  }

  /** The caller's follow-up to `helper` starts, owned and reported to `by`. */
  async function continues(
    from: string,
    helper: z.infer<typeof receipt>,
    by: z.infer<typeof receipt>
  ) {
    const sent = await follow(from, helper.dispatchId)
    expect(sent.error).toBeUndefined()
    const continued = receipt.parse(sent.result)
    expect(h.db.getDispatchContextById(continued.dispatchId)?.creator_dispatch_id).toBe(
      by.dispatchId
    )
    expect(h.db.getTask(continued.taskId)?.parent_id).toBe(by.taskId)
    return continued
  }

  function otherRun() {
    return h.db.createRun({
      objective: 'another Run',
      coordinatorHandle: 'term_other_coord',
      coordinatorPaneKey: h.runtime.getTerminalPaneKey('term_other_coord')
    }).id
  }

  const depthOf = (dispatch: z.infer<typeof receipt>) =>
    h.db.getDispatchContextById(dispatch.dispatchId)!.depth

  function effects() {
    return {
      tasks: h.db.listTasks().length,
      dispatches: h.db.db.prepare('SELECT COUNT(*) AS n FROM dispatch_contexts').get(),
      resources: h.db.db.prepare('SELECT * FROM worker_terminal_resources ORDER BY id').all(),
      closes: vi.mocked(h.runtime.closeTerminal).mock.calls.length,
      creates: vi.mocked(h.runtime.createTerminal).mock.calls.length,
      prompts: vi.mocked(h.runtime.sendTerminalAgentPrompt).mock.calls.length
    }
  }

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
      const sessionId = testOrcaSessionId('helper-follow-up')
      rig = await createQueuedMessageTestRig({
        sessionId,
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'repo::worktree',
          workspaceKind: 'git-worktree'
        }
      })
      const current = rig
      setStructuredAgentSessionHost(current.host)
      vi.spyOn(h.runtime, 'ensureStructuredAgentSessionHost').mockResolvedValue()
      vi.spyOn(h.runtime, 'publishStructuredAgentSessionTab').mockResolvedValue()
      structuredHandle = mintStructuredWorkerHandle()
      const identity = structuredWorkerIdentities.register({
        handle: structuredHandle,
        sessionId,
        agent: 'codex',
        paneKey: mintStructuredWorkerPaneKey(sessionId),
        processIncarnation: structuredWorkerProcessIncarnation(sessionId),
        worktreeId: 'repo::worktree',
        hostScope: { kind: 'local', hostId: 'local' }
      })
      vi.spyOn(placement, 'placeWorkerAgent').mockImplementationOnce(async (args) => ({
        mode: args.mode,
        worktree: { id: 'repo::worktree', repoId: 'repo' },
        terminalHandle: identity.handle,
        setupReceipt: placement.EXISTING_WORKTREE_SETUP,
        structuredSession: {
          host: current.host,
          identity,
          fence: current.store.requireWritableRecord(sessionId).lease.runtimeFence
        }
      }))
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
      const helper = await acceptChat(start('term_worker', structuredHandle))
      await report(structuredHandle, helper, `dispatch:${worker.dispatchId}`)
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
      nextTerminal = 'term_fresh'
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
    nextTerminal = 'term_helper_again'
    const continuedHelper = await continues('term_worker', helper, continuedWorker)
    await report('term_helper_again', continuedHelper, `dispatch:${continuedWorker.dispatchId}`)
    expect(h.db.getUnreadMessages(`dispatch:${continuedWorker.dispatchId}`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
    )
  })

  it.each(['live', 'closed', 'unreadable history'] as const)(
    'lets a worker reopened on its own pane continue its %s helper',
    async (state) => {
      const { worker, helper } = await pair()
      await report('term_worker', worker, 'term_coord')
      if (state === 'closed') {
        await success('worker-release', '--dispatch', helper.dispatchId)
      }
      // The guide's recovery: reopen the worker's Task and start it on the agent that already runs.
      await success(
        'task-update',
        '--from',
        'term_coord',
        '--id',
        worker.taskId,
        '--status',
        'ready'
      )
      const reopened = receipt.parse(
        await success(
          'worker-start',
          '--from',
          'term_coord',
          '--task',
          worker.taskId,
          '--terminal',
          'term_worker'
        )
      )
      const custody = h.db.getWorkerTerminalResourceByOwner(reopened.dispatchId)!
      expect(custody).toMatchObject({
        origin_dispatch_id: worker.dispatchId,
        prior_owner_dispatch_ids: JSON.stringify([worker.dispatchId])
      })
      expect(h.db.getDispatchContextById(reopened.dispatchId)?.follow_up_of_dispatch_id).toBeNull()
      if (state === 'unreadable history') {
        h.db.db
          .prepare('UPDATE worker_terminal_resources SET prior_owner_dispatch_ids = ? WHERE id = ?')
          .run('not-json', custody.id)
        const before = effects()
        expect((await follow('term_worker', helper.dispatchId)).error).toMatchObject({
          code: 'task_not_found'
        })
        expect(effects()).toEqual(before)
        return
      }
      nextTerminal = 'term_helper_again'
      const continued = await continues('term_worker', helper, reopened)
      await report(
        state === 'live' ? 'term_helper' : 'term_helper_again',
        continued,
        `dispatch:${reopened.dispatchId}`
      )
      expect(h.db.getUnreadMessages(`dispatch:${reopened.dispatchId}`)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
      )
    }
  )

  it('follows takeovers and fresh follow-ups together back to the worker that started each helper', async () => {
    const first = await start('term_coord', 'term_worker')
    const early = await start('term_worker', 'term_early')
    await report('term_early', early, `dispatch:${first.dispatchId}`)
    await report('term_worker', first, 'term_coord')
    const second = await takeOver('term_coord', 'term_worker')
    const helper = await start('term_worker', 'term_helper')
    await report('term_helper', helper, `dispatch:${second.dispatchId}`)
    await report('term_worker', second, 'term_coord')
    await success('worker-release', '--dispatch', second.dispatchId)
    nextTerminal = 'term_worker_fresh'
    const third = receipt.parse((await follow('term_coord', second.dispatchId)).result)
    expect(h.db.getDispatchContextById(third.dispatchId)?.follow_up_of_dispatch_id).toBe(
      second.dispatchId
    )
    await report('term_worker_fresh', third, 'term_coord')
    const fourth = await takeOver('term_coord', 'term_worker_fresh')
    // Neither the current pane nor its resource's origin names the workers that started these helpers.
    expect(h.db.getWorkerTerminalResourceByOwner(fourth.dispatchId)).toMatchObject({
      origin_dispatch_id: third.dispatchId,
      prior_owner_dispatch_ids: JSON.stringify([third.dispatchId])
    })
    nextTerminal = 'term_helper_again'
    await continues('term_worker_fresh', helper, fourth)
    await continues('term_worker_fresh', early, fourth)
  })

  it('refuses a helper whose creator reached the caller only through another Run', async () => {
    const { worker, helper } = await pair()
    await report('term_worker', worker, 'term_coord')
    const elsewhere = otherRun()
    const visitor = await takeOver('term_other_coord', 'term_worker')
    await report('term_worker', visitor, 'term_other_coord')
    const back = await takeOver('term_coord', 'term_worker')
    expect(h.db.getDispatchContextById(visitor.dispatchId)?.run_id).toBe(elsewhere)
    expect(h.db.getWorkerTerminalResourceByOwner(back.dispatchId)?.prior_owner_dispatch_ids).toBe(
      JSON.stringify([worker.dispatchId, visitor.dispatchId])
    )
    const before = effects()
    expect((await follow('term_worker', helper.dispatchId)).error).toMatchObject({
      code: 'task_not_found',
      message: expect.stringContaining(`is not a helper of Dispatch ${back.dispatchId}`)
    })
    expect(effects()).toEqual(before)
  })

  it.each(['the original address', 'the failed attempt'] as const)(
    'keeps a helper its worker’s after coordinator attempts that never got an agent, through %s',
    async (address) => {
      const { worker, helper } = await pair()
      await success('worker-release', '--dispatch', helper.dispatchId)
      const failedIds: string[] = []
      for (let attempt = 0; attempt < 2; attempt++) {
        vi.mocked(h.runtime.createTerminal).mockRejectedValueOnce(new Error('spawn failed'))
        const { result } = await follow('term_coord', helper.dispatchId)
        expect(result).toMatchObject({ state: 'failed', failedStage: 'terminal_create' })
        failedIds.push(receipt.omit({ state: true }).parse(result).dispatchId)
      }
      const failedAgain = h.db.getDispatchContextById(failedIds[1])!
      expect(failedAgain.follow_up_of_dispatch_id).toBe(failedIds[0])
      nextTerminal = 'term_helper_again'
      const sent = await follow(
        'term_worker',
        address === 'the original address' ? helper.dispatchId : failedAgain.id
      )
      expect(sent.error).toBeUndefined()
      const continued = receipt.parse(sent.result)
      expect(h.db.getDispatchContextById(continued.dispatchId)).toMatchObject({
        creator_dispatch_id: worker.dispatchId,
        follow_up_of_dispatch_id: failedAgain.id
      })
      expect(h.db.getDispatchContextById(helper.dispatchId)?.creator_dispatch_id).toBe(
        worker.dispatchId
      )
    }
  )

  it.each(['succeeded', 'failed'] as const)(
    'refuses a helper the coordinator took over, whose continuation %s',
    async (outcome) => {
      const { worker, helper } = await pair()
      const taken = receipt.parse((await follow('term_coord', helper.dispatchId)).result)
      h.settle(taken.taskId, taken.dispatchId, outcome)
      const before = effects()
      expect((await follow('term_worker', helper.dispatchId)).error).toMatchObject({
        code: 'task_not_found',
        message: expect.stringContaining(
          `Dispatch ${helper.dispatchId}'s latest work, Dispatch ${taken.dispatchId}, is not a helper of Dispatch ${worker.dispatchId}`
        )
      })
      expect(effects()).toEqual(before)
    }
  )

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
      nextTerminal = `${child}_continued`
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
