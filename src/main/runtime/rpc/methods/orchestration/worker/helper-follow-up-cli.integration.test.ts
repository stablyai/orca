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
const failure = z.object({ error: z.object({ code: z.string(), message: z.string() }) })

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

  const follow = (from: string, id: string) =>
    cli(
      'send',
      '--from',
      from,
      '--to',
      `dispatch:${id}`,
      '--subject',
      'More',
      '--body',
      'also check the result'
    )

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

  it.each(['release', 'acceptance'] as const)(
    'fences a creator that settles during placement before %s',
    async (boundary) => {
      const { worker, helper } = await pair()
      const gate = h.deferred<void>()
      const entered = h.deferred<void>()
      if (boundary === 'release') {
        vi.mocked(h.runtime.isTerminalRunningAgent).mockImplementationOnce(async () => {
          entered.resolve()
          await gate.promise
          return false
        })
      } else {
        const show = vi.mocked(h.runtime.showManagedTerminalWorkspace).getMockImplementation()!
        let reads = 0
        vi.mocked(h.runtime.showManagedTerminalWorkspace).mockImplementation(async (...args) => {
          if (++reads === 2) {
            entered.resolve()
            await gate.promise
          }
          return show(...args)
        })
      }
      const pending = follow('term_worker', helper.dispatchId)
      await entered.promise
      h.settle(worker.taskId, worker.dispatchId, 'succeeded')
      const afterSettlement = effects()
      gate.resolve()
      expect((await pending).error).toMatchObject({ code: 'consumer_fenced' })
      expect(effects()).toEqual(afterSettlement)
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
      await start('term_coord', 'term_worker')
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
      const sent = await follow('term_worker', foreign.dispatchId)
      expect(sent.error).toMatchObject({ code: 'task_not_found' })
      expect(effects()).toEqual(before)
      expect(getFollowUpDispatch(h.db, foreign.dispatchId)).toBeUndefined()
    }
  )

  it('refuses coordinator work, cross-Run coordinators and unattached callers before cleanup', async () => {
    const target = await start('term_coord', 'term_target')
    await report('term_target', target, 'term_coord')
    await start('term_coord', 'term_worker')
    h.db.createRun({
      objective: 'another Run',
      coordinatorHandle: 'term_other_coord',
      coordinatorPaneKey: h.runtime.getTerminalPaneKey('term_other_coord')
    })
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
    const sent = await follow('term_worker', helper.dispatchId)
    expect(sent.error).toBeUndefined()
    const continuedHelper = receipt.parse(sent.result)
    expect(h.db.getDispatchContextById(continuedHelper.dispatchId)?.creator_dispatch_id).toBe(
      continuedWorker.dispatchId
    )
    expect(h.db.getTask(continuedHelper.taskId)?.parent_id).toBe(continuedWorker.taskId)
    await report('term_helper_again', continuedHelper, `dispatch:${continuedWorker.dispatchId}`)
    expect(h.db.getUnreadMessages(`dispatch:${continuedWorker.dispatchId}`)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
    )
  })

  it('does not inherit helpers through a generic transfer of the creator’s pane', async () => {
    const { worker, helper } = await pair()
    await report('term_worker', worker, 'term_coord')
    await success(
      'worker-start',
      '--from',
      'term_coord',
      '--spec',
      'different work',
      '--terminal',
      'term_worker'
    )
    const before = effects()
    expect((await follow('term_worker', helper.dispatchId)).error).toMatchObject({
      code: 'task_not_found'
    })
    expect(effects()).toEqual(before)
  })

  it('validates the assembled fresh Task including earlier work before creating a successor', async () => {
    const { helper } = await pair()
    await success('worker-release', '--dispatch', helper.dispatchId)
    const before = effects()
    const sent = await cli(
      'send',
      '--from',
      'term_worker',
      '--to',
      `dispatch:${helper.dispatchId}`,
      '--subject',
      'More',
      '--body',
      'x'.repeat(ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES - 1)
    )
    expect(sent.error).toMatchObject({ code: 'worker_prompt_too_large' })
    expect(effects()).toEqual(before)
  })

  it('bounds ownership reads by explicit sender ancestry at N and 10N', async () => {
    const counts: number[] = []
    for (const depth of [3, 30]) {
      const sender = `term_sender_${depth}`
      const child = `term_child_${depth}`
      let worker = await start('term_coord', sender)
      const helper = await start(sender, child)
      await report(child, helper, `dispatch:${worker.dispatchId}`)
      await success('worker-release', '--dispatch', helper.dispatchId)
      for (let step = 0; step < depth; step++) {
        await report(sender, worker, 'term_coord')
        worker = receipt.parse((await follow('term_coord', worker.dispatchId)).result)
      }
      const read = vi.spyOn(h.db, 'getDispatchContextById')
      read.mockClear()
      nextTerminal = `${child}_continued`
      expect((await follow(sender, helper.dispatchId)).error).toBeUndefined()
      counts.push(read.mock.calls.length)
      expect(read.mock.calls.length).toBeLessThanOrEqual(depth + 40)
      read.mockRestore()
    }
    expect(counts[1] - counts[0]).toBeLessThanOrEqual(30 - 3)
  })
})
