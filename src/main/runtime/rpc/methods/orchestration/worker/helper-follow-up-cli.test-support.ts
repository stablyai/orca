import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import { z } from 'zod'
import type * as CliRuntimeClient from '../../../../../../cli/runtime-client'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { getWorkerTerminalAutoReleaseScheduler } from '../../../../orchestration/worker-terminal-auto-release-scheduler'
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

export const receipt = z.object({
  taskId: z.string(),
  dispatchId: z.string(),
  state: z.literal('ready')
})
export type Started = { taskId: string; dispatchId: string }
const failure = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    data: z.record(z.string(), z.unknown()).optional()
  })
})

/** Real CLI argv -> RPC schema and handlers -> SQLite, with terminal IO and native placement supplied by the fixture. */
export function useHelperFollowUpCli(options: { fileBacked?: boolean } = {}) {
  const h = createOrchestrationWorkerReleaseHarness()
  const output = vi.fn<(value: { result: unknown }) => void>()
  const panes = new Map<string, string>()
  let main: (argv: string[]) => Promise<void>
  let logs: ReturnType<typeof vi.spyOn<typeof console, 'log'>>
  let nextTerminal = 'term_worker'
  let rig: QueuedMessageTestRig | undefined
  let structuredHandle: string | undefined
  let userDataDir: string | undefined

  /** The fixture's terminals and CLI output; armed again after a restart drops every mock. */
  function arm() {
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
    logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  }

  beforeEach(async () => {
    userDataDir = options.fileBacked ? mkdtempSync(join(tmpdir(), 'helper-follow-up-')) : undefined
    h.setup({ userDataDir })
    panes.clear()
    for (const name of ['AGENT_SESSION_ID', 'TERMINAL_HANDLE', 'PANE_KEY', 'PAIRING_CODE']) {
      vi.stubEnv(`ORCA_${name}`, '')
    }
    vi.stubEnv('ORCA_ENVIRONMENT', '')
    arm()
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
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true })
    }
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
    const spec = `work by ${handle}`
    return receipt.parse(
      await success('worker-start', '--from', from, '--spec', spec, '--agent', 'codex')
    )
  }

  async function report(from: string, task: Started, to: string) {
    const payload = JSON.stringify({ ...task, state: undefined, outcome: 'succeeded' })
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
      payload
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

  /** The guide's recovery: reopen the worker's Task and start it on the agent that already runs. */
  async function reopenOn(worker: Started, terminal: string) {
    await success('task-update', '--from', 'term_coord', '--id', worker.taskId, '--status', 'ready')
    const args = ['--from', 'term_coord', '--task', worker.taskId, '--terminal', terminal]
    return receipt.parse(await success('worker-start', ...args))
  }

  /** The caller's follow-up to `helper` starts, owned and reported to `by`. */
  async function continues(from: string, helper: Started, by: Started) {
    const sent = await follow(from, helper.dispatchId)
    expect(sent.error).toBeUndefined()
    const continued = receipt.parse(sent.result)
    expect(h.db.getDispatchContextById(continued.dispatchId)?.creator_dispatch_id).toBe(
      by.dispatchId
    )
    expect(h.db.getTask(continued.taskId)?.parent_id).toBe(by.taskId)
    return continued
  }

  /** The next worker-start places its agent in a native chat. */
  async function placeNextWorkerInChat() {
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
    return { current, identity, sessionId }
  }

  function otherRun() {
    return h.db.createRun({
      objective: 'another Run',
      coordinatorHandle: 'term_other_coord',
      coordinatorPaneKey: h.runtime.getTerminalPaneKey('term_other_coord')
    }).id
  }

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

  return {
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
    effects,
    reopenOn,
    restart() {
      h.restart()
      arm()
    },
    set nextTerminal(handle: string) {
      nextTerminal = handle
    }
  }
}
