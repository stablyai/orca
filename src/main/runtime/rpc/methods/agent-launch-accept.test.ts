import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import '../unused-default-rpc-methods.test-fixture'
/** A desktop new-workspace chat accepted before its workspace's required Setup: the host owns the wait
 * and the one surface that follows it, and a caller reads the launch rather than inferring it. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSetupRun, type SetupRun } from '../../setup/setup-run'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStubOptions
} from './agent-launch.test-fixture'
import {
  noteStructuredAgentSessionClose,
  resetStructuredAgentSessionClosesBeforeCreateForTests
} from './structured-agent-session-close-before-create'

type StructuredCreateArgs = {
  envelope: { sessionId: string }
  tabId?: string
  firstMessage?: { clientMessageId: string }
}

const createStructured = vi.hoisted(() =>
  vi.fn(async (args: StructuredCreateArgs) => ({
    ok: true as const,
    value: {
      sessionId: args.envelope.sessionId,
      fence: 1,
      ...(args.tabId ? { tabId: args.tabId } : {}),
      ...(args.firstMessage ? { firstMessage: args.firstMessage } : {})
    }
  }))
)
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructured
}))

const { AGENT_LAUNCH_ACCEPT_METHODS } = await import('./agent-launch-accept')
const ACCEPT = methodNamed(AGENT_LAUNCH_ACCEPT_METHODS, 'agent.launchAccept')
const STATUS = methodNamed(AGENT_LAUNCH_ACCEPT_METHODS, 'agent.launchStatus')

// The ledger admits against `Date.now()`, so the id must be dated now.
const OPERATION_ID = `${Date.now()}-000000000000000000000000000000ac`
const SESSION_ID = 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const PANE_KEY = `${TAB_ID}:3f2504e0-4f89-41d3-9a0c-0305e82c3301`
const HELD_MESSAGE = 'fix the failing test'
/** What the desktop sends once its new workspace exists: its own terminal plan rides along. */
const ACCEPTED = {
  agent: 'claude',
  operationId: OPERATION_ID,
  target: { kind: 'existing', worktree: 'id:wt-7' },
  sessionId: SESSION_ID,
  paneKey: PANE_KEY,
  nativeChatDefault: true,
  prompt: { text: HELD_MESSAGE, delivery: 'submit' },
  terminalStartup: {
    command: "claude --model 'opus'",
    env: { ORCA_LAUNCH: '1' },
    promptDelivery: 'draft'
  }
}
/** Exactly what the desktop's `runtime:call` handler hands the dispatcher. */
const DESKTOP: Partial<RpcContext> = {
  clientId: 'desktop-renderer',
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime',
  clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
}

let directory: string
let store: AgentSessionRecordStore
const runs: SetupRun[] = []

function setupRun(): SetupRun {
  const run = createSetupRun(true)
  runs.push(run)
  return run
}

function hostRuntime(run: SetupRun | undefined, options: AgentLaunchRuntimeStubOptions = {}) {
  return Object.assign(runtimeStub({ terminalPaneKey: PANE_KEY, ...options }), {
    getSetupRun: vi.fn((_worktreeId: string) => run),
    pasteStartupDraftWhenReady: vi.fn((_handle: string, _draft: unknown) => {}),
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}
type HostRuntime = ReturnType<typeof hostRuntime>

function accept(runtime: HostRuntime, params: unknown = ACCEPTED) {
  return ACCEPT.handler(ACCEPT.params.parse(params), rpcContext(runtime, DESKTOP))
}

function status(runtime: HostRuntime, waitMs?: number) {
  return STATUS.handler(
    STATUS.params.parse({ operationId: OPERATION_ID, ...(waitMs ? { waitMs } : {}) }),
    rpcContext(runtime, DESKTOP)
  )
}

function noSurface(runtime: HostRuntime): void {
  expect(createStructured).not.toHaveBeenCalled()
  expect(runtime.createTerminal).not.toHaveBeenCalled()
}

beforeEach(async () => {
  createStructured.mockClear()
  resetStructuredAgentSessionClosesBeforeCreateForTests()
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-accept-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  for (const run of runs.splice(0)) {
    run.settle({ kind: 'ended', reason: 'closed' })
  }
  setAgentLaunchRecordStore(null)
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('a launch accepted while its workspace runs required Setup', () => {
  it('answers at once, starts nothing until Setup succeeds, then opens the reserved chat', async () => {
    const run = setupRun()
    const runtime = hostRuntime(run)

    await expect(accept(runtime)).resolves.toEqual({ operationId: OPERATION_ID, state: 'running' })
    await expect(status(runtime, 20)).resolves.toEqual({ state: 'running' })
    noSurface(runtime)
    // Native support is asked after Setup, and no chat record exists before dispatch.
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION_ID)).toBeNull()

    run.settle({ kind: 'succeeded' })

    await expect(status(runtime, 5_000)).resolves.toMatchObject({
      state: 'succeeded',
      result: {
        outcome: { kind: 'structured', sessionId: SESSION_ID, tabId: TAB_ID },
        prompt: { delivery: 'submit', outcome: 'journaled' }
      }
    })
    expect(createStructured).toHaveBeenCalledOnce()
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('ends failed with no agent when Setup fails', async () => {
    const run = setupRun()
    const runtime = hostRuntime(run)
    await accept(runtime)

    run.settle({ kind: 'failed', exitCode: 1 })

    await expect(status(runtime, 5_000)).resolves.toMatchObject({
      state: 'failed',
      code: 'agent_launch_setup_not_completed',
      message: expect.stringContaining('Setup failed, so Claude was not started')
    })
    noSurface(runtime)
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it('starts the caller’s own terminal command when the host cannot run the chat, leaving the message unsent', async () => {
    const run = setupRun()
    const runtime = hostRuntime(run, { createSupport: { supported: false, reason: 'agent' } })
    await accept(runtime)

    run.settle({ kind: 'succeeded' })

    await expect(status(runtime, 5_000)).resolves.toMatchObject({
      state: 'succeeded',
      result: {
        outcome: { kind: 'terminal', handle: 'term_1', paneKey: PANE_KEY },
        receipt: { mode: 'terminal', preferred: 'structured' },
        prompt: { delivery: 'draft', outcome: 'not-delivered' }
      }
    })
    expect(createStructured).not.toHaveBeenCalled()
    const [selector, options] = runtime.createTerminal.mock.calls[0] ?? []
    expect(selector).toBe('id:wt-7')
    expect(options).toMatchObject({
      command: "claude --model 'opus'",
      env: { ORCA_LAUNCH: '1' },
      launchAgent: 'claude'
    })
    expect(options).not.toHaveProperty('startupAgent')
    expect(options).not.toHaveProperty('startupPrompt')
    expect(runtime.pasteStartupDraftWhenReady).toHaveBeenCalledWith('term_1', {
      agent: 'claude',
      content: HELD_MESSAGE
    })
  })

  it('starts nothing once the reserved chat is closed before dispatch', async () => {
    const run = setupRun()
    const runtime = hostRuntime(run)
    await accept(runtime)

    noteStructuredAgentSessionClose(SESSION_ID, false)

    await expect(status(runtime, 5_000)).resolves.toEqual({
      state: 'failed',
      code: 'agent_launch_tab_closed'
    })
    run.settle({ kind: 'succeeded' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    noSurface(runtime)
  })

  it('reads unknown after a host restart and never runs the accepted launch again', async () => {
    const dying = hostRuntime(setupRun())
    await accept(dying)

    // A new process: the store reread from disk, and nothing in flight.
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
    // No Setup to wait for here: a second run would start its chat at once.
    const restarted = hostRuntime(undefined)

    await expect(status(restarted)).resolves.toEqual({ state: 'unknown' })
    await expect(accept(restarted)).resolves.toEqual({
      operationId: OPERATION_ID,
      state: 'unknown'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    noSurface(restarted)
    noSurface(dying)
  })
})
