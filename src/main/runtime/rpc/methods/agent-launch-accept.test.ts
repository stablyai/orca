import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import '../unused-default-rpc-methods.test-fixture'
/** A desktop new-workspace chat accepted before its workspace's required Setup: the host owns the wait
 * and the one surface that follows it, and a caller reads the launch rather than inferring it. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSetupRun, type SetupRun } from '../../setup/setup-run'
import { buildAgentStartupPlan } from '../../../../shared/tui-agent-startup'
import type * as StructuredCreate from './structured-agent-session-create'
import { sharedPromiseSettlementWaiters } from '../../../../shared/promise-settlement-waiters'
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
const { activeAgentLaunchesFor } = await import('./agent-launch-in-flight')
const ACCEPT = methodNamed(AGENT_LAUNCH_ACCEPT_METHODS, 'agent.launchAccept')
const STATUS = methodNamed(AGENT_LAUNCH_ACCEPT_METHODS, 'agent.launchStatus')

// The ledger admits against `Date.now()`, so the id must be dated now.
const OPERATION_ID = `${Date.now()}-000000000000000000000000000000ac`
const SESSION_ID = 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const PANE_KEY = `${TAB_ID}:3f2504e0-4f89-41d3-9a0c-0305e82c3301`
const HELD_MESSAGE = 'fix the failing test'
const MESSAGE_ID = 'message-3f2504e0'
/** What the desktop sends once its new workspace exists: its own terminal plan rides along. */
const ACCEPTED = {
  agent: 'claude',
  operationId: OPERATION_ID,
  target: { kind: 'existing', worktree: 'id:wt-7' },
  sessionId: SESSION_ID,
  paneKey: PANE_KEY,
  nativeChatDefault: true,
  prompt: { text: HELD_MESSAGE, delivery: 'submit', clientMessageId: MESSAGE_ID },
  terminalStartup: {
    kind: 'command',
    command: "claude --model 'opus'",
    env: { ORCA_LAUNCH: '1' },
    prompt: 'draft'
  },
  setupReceipt: { required: false }
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
    deliverStartupFollowup: vi.fn(async (_handle: string, _followup: unknown) => true),
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}
type HostRuntime = ReturnType<typeof hostRuntime>

function accept(runtime: HostRuntime, params: unknown = ACCEPTED) {
  return ACCEPT.handler(ACCEPT.params.parse(params), rpcContext(runtime, DESKTOP))
}

/** The accept a creation that named `run` as its required Setup sends. */
function awaiting(run: SetupRun, overrides: Record<string, unknown> = {}) {
  return { ...ACCEPTED, setupReceipt: { required: true, runId: run.id }, ...overrides }
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

    await expect(accept(runtime, awaiting(run))).resolves.toEqual({
      operationId: OPERATION_ID,
      state: 'running'
    })
    await expect(status(runtime, 20)).resolves.toEqual({ state: 'running' })
    noSurface(runtime)
    // Native support is asked after Setup, and no chat record exists before dispatch.
    expect(runtime.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION_ID)).toBeNull()

    run.settle({ kind: 'succeeded' })

    // The chat founds the held message under the desktop's own id, so both name one message.
    await expect(status(runtime, 5_000)).resolves.toMatchObject({
      state: 'succeeded',
      result: {
        outcome: { kind: 'structured', sessionId: SESSION_ID, tabId: TAB_ID },
        prompt: { delivery: 'submit', outcome: 'journaled', messageId: MESSAGE_ID }
      }
    })
    expect(createStructured).toHaveBeenCalledOnce()
    expect(createStructured.mock.calls[0]?.[0].firstMessage).toMatchObject({
      clientMessageId: MESSAGE_ID
    })
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('ends failed with no agent when Setup fails', async () => {
    const run = setupRun()
    const runtime = hostRuntime(run)
    await accept(runtime, awaiting(run))

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
    await accept(runtime, awaiting(run))

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
    await accept(runtime, awaiting(run))

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
    const run = setupRun()
    const dying = hostRuntime(run)
    await accept(dying, awaiting(run))

    // A new process: the store reread from disk, and nothing in flight.
    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
    // The new host holds no Setup run either: the claimed row alone answers.
    const restarted = hostRuntime(undefined)

    await expect(status(restarted)).resolves.toEqual({ state: 'unknown' })
    await expect(accept(restarted, awaiting(run))).resolves.toEqual({
      operationId: OPERATION_ID,
      state: 'unknown'
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    noSurface(restarted)
    noSurface(dying)
  })
})

describe('the Setup a launch waits for is the one its workspace creation named', () => {
  it('starts nothing on a host that never saw that run, as after a restart before the first accept', async () => {
    // The creation replied naming its run; the host restarted and holds none, or a newer one.
    for (const held of [undefined, setupRun()]) {
      createStructured.mockClear()
      const runtime = hostRuntime(held)
      const operationId = `${Date.now()}-${'0'.repeat(30)}${held ? 'b2' : 'b1'}`
      await accept(runtime, {
        ...ACCEPTED,
        operationId,
        setupReceipt: { required: true, runId: 'run-the-old-host-made' }
      })
      await expect(
        STATUS.handler({ operationId, waitMs: 5_000 }, rpcContext(runtime, DESKTOP))
      ).resolves.toMatchObject({
        state: 'failed',
        code: 'agent_launch_setup_not_completed',
        message: expect.stringContaining('Orca could not confirm that Setup finished')
      })
      noSurface(runtime)
    }
  })

  it('waits for nothing when the creation required no Setup, even beside a running one', async () => {
    const runtime = hostRuntime(setupRun())
    await accept(runtime)
    await expect(status(runtime, 5_000)).resolves.toMatchObject({ state: 'succeeded' })
    expect(createStructured).toHaveBeenCalledOnce()
    expect(runtime.getSetupRun).not.toHaveBeenCalled()
  })

  it('answers a recorded launch before it reads this host’s Setup again', async () => {
    const run = setupRun()
    const runtime = hostRuntime(run)
    await accept(runtime, awaiting(run))
    run.settle({ kind: 'succeeded' })
    await expect(status(runtime, 5_000)).resolves.toMatchObject({ state: 'succeeded' })

    await expect(accept(runtime, awaiting(run))).resolves.toMatchObject({ state: 'succeeded' })
    expect(runtime.getSetupRun).toHaveBeenCalledOnce()
    expect(createStructured).toHaveBeenCalledOnce()
  })
})

describe('overlapping and changed accepts of one operation', () => {
  it('answers an identical accept at once, while Setup still runs', async () => {
    const run = setupRun()
    const runtime = hostRuntime(run)
    const first = accept(runtime, awaiting(run))
    const second = accept(runtime, awaiting(run))
    const answered = await Promise.race([
      Promise.all([first, second]),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 200))
    ])
    expect(answered).toEqual([
      { operationId: OPERATION_ID, state: 'running' },
      { operationId: OPERATION_ID, state: 'running' }
    ])
    run.settle({ kind: 'succeeded' })
    await expect(status(runtime, 5_000)).resolves.toMatchObject({ state: 'succeeded' })
    expect(createStructured).toHaveBeenCalledOnce()
  })

  it.each([
    ['terminal command', { terminalStartup: { ...ACCEPTED.terminalStartup, command: 'claude' } }],
    ['message id', { prompt: { ...ACCEPTED.prompt, clientMessageId: 'message-other' } }],
    ['Setup receipt', { setupReceipt: { required: true, runId: 'run-other' } }]
  ])('refuses the same id with a different %s, running or recorded', async (_label, changed) => {
    const run = setupRun()
    const runtime = hostRuntime(run)
    await accept(runtime, awaiting(run))
    await expect(accept(runtime, awaiting(run, changed))).rejects.toThrow(
      'agent_session_operation_conflict'
    )
    run.settle({ kind: 'succeeded' })
    await expect(status(runtime, 5_000)).resolves.toMatchObject({ state: 'succeeded' })
    await expect(accept(runtime, awaiting(run, changed))).rejects.toThrow(
      'agent_session_operation_conflict'
    )
  })

  it('leaves nothing behind for a status read that times out', async () => {
    const run = setupRun()
    const runtime = hostRuntime(run)
    await accept(runtime, awaiting(run))
    const [active] = [...activeAgentLaunchesFor(rpcContext(runtime, DESKTOP).runtime).values()]
    const reactions = vi.spyOn(active.promise, 'then')
    for (let read = 0; read < 3; read += 1) {
      await expect(status(runtime, 1)).resolves.toEqual({ state: 'running' })
    }
    // One shared observer for every read; each expired read's own waiter is gone.
    expect(reactions.mock.calls.length).toBeLessThanOrEqual(1)
    expect(sharedPromiseSettlementWaiters(active.promise).waiterCount).toBe(0)
    reactions.mockRestore()
    run.settle({ kind: 'succeeded' })
    await expect(status(runtime, 5_000)).resolves.toMatchObject({ state: 'succeeded' })
  })
})

describe('the terminal alternative runs the caller’s plan once', () => {
  const claudePlan = buildAgentStartupPlan({
    agent: 'claude',
    prompt: HELD_MESSAGE,
    cmdOverrides: {},
    platform: 'linux'
  })

  it.each([
    // The planner put the message on the command line: running it is the delivery.
    {
      prompt: 'carried',
      receipt: { delivery: 'submit', outcome: 'handed-to-terminal' },
      sent: 0,
      pasted: 0
    },
    {
      prompt: 'submit',
      receipt: { delivery: 'submit', outcome: 'handed-to-terminal' },
      sent: 1,
      pasted: 0
    },
    {
      prompt: 'draft',
      receipt: { delivery: 'draft', outcome: 'not-delivered' },
      sent: 0,
      pasted: 1
    },
    {
      prompt: 'none',
      receipt: { delivery: 'submit', outcome: 'not-delivered' },
      sent: 0,
      pasted: 0
    }
  ])('delivers a $prompt message as planned', async ({ prompt, receipt, sent, pasted }) => {
    expect(claudePlan?.launchCommand).toContain(HELD_MESSAGE)
    const runtime = hostRuntime(undefined, { createSupport: { supported: false, reason: 'agent' } })
    const command = prompt === 'carried' ? claudePlan?.launchCommand : 'claude'
    await accept(runtime, {
      ...ACCEPTED,
      terminalStartup: { kind: 'command', command, launchConfig: claudePlan?.launchConfig, prompt }
    })
    await expect(status(runtime, 5_000)).resolves.toMatchObject({
      state: 'succeeded',
      result: { outcome: { kind: 'terminal' }, prompt: receipt }
    })
    expect(runtime.createTerminal.mock.calls[0]?.[1]).toMatchObject({ command })
    expect(runtime.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('startupPrompt')
    expect(runtime.deliverStartupFollowup).toHaveBeenCalledTimes(sent)
    expect(runtime.pasteStartupDraftWhenReady).toHaveBeenCalledTimes(pasted)
  })

  it('starts the host’s own launcher for the agent when that is the plan', async () => {
    const runtime = hostRuntime(undefined, { createSupport: { supported: false, reason: 'agent' } })
    await accept(runtime, { ...ACCEPTED, terminalStartup: { kind: 'agent', prompt: 'none' } })
    await expect(status(runtime, 5_000)).resolves.toMatchObject({
      state: 'succeeded',
      result: { prompt: { outcome: 'not-delivered' } }
    })
    expect(runtime.createTerminal.mock.calls[0]?.[1]).toMatchObject({ startupAgent: 'claude' })
    expect(runtime.createTerminal.mock.calls[0]?.[1]).not.toHaveProperty('startupPrompt')
  })

  it('starts no terminal the caller did not plan', async () => {
    const runtime = hostRuntime(undefined, { createSupport: { supported: false, reason: 'agent' } })
    const { terminalStartup: _none, ...withoutAlternative } = ACCEPTED
    await accept(runtime, withoutAlternative)
    await expect(status(runtime, 5_000)).resolves.toMatchObject({
      state: 'failed',
      code: 'agent_launch_surface_unavailable',
      message: expect.stringContaining("Claude can't open as a chat here")
    })
    noSurface(runtime)
  })

  it('starts the planned command under the account prepared for this launch', async () => {
    const runtime = hostRuntime(undefined, { createSupport: { supported: false, reason: 'wsl' } })
    const accountEnv = { CLAUDE_CONFIG_DIR: '/home/u/.orca/claude-accounts/acct-a/config' }
    await accept(runtime, { ...ACCEPTED, accountEnv })
    await expect(status(runtime, 5_000)).resolves.toMatchObject({ state: 'succeeded' })
    expect(runtime.createTerminal.mock.calls[0]?.[1]).toMatchObject({
      command: "claude --model 'opus'",
      env: { ORCA_LAUNCH: '1', ...accountEnv }
    })
  })
})

describe('a close while the accepted launch prepares its surface', () => {
  it.each([true, false])(
    'founds no chat and starts no agent (first message=%s)',
    async (withMessage) => {
      const { createRestTestRig } =
        await import('../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig')
      const { setStructuredAgentSessionHost } =
        await import('../../../native-chat/agent-session-wire/structured-agent-session-registry')
      const actual = await vi.importActual<typeof StructuredCreate>(
        './structured-agent-session-create'
      )
      const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
      rig.clock.now = Date.now()
      setStructuredAgentSessionHost(rig.host)
      const sessionId = 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
      const preparing = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const runtime = Object.assign(hostRuntime(undefined), {
        resolveStructuredAgentSessionCreateIntent: vi.fn(async (args: { envelope: unknown }) => {
          preparing.resolve()
          await release.promise
          return {
            envelope: args.envelope,
            location: {
              executionHostId: 'local',
              wslDistro: null,
              workspaceId: 'wt-7',
              workspaceKind: 'git-worktree'
            },
            provider: 'codex',
            agent: 'codex',
            accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
            runtimeKind: 'native'
          }
        }),
        publishStructuredAgentSessionTab: vi.fn(async () => {})
      })
      createStructured.mockImplementationOnce(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch hands the real create its real arguments; the mock's narrow type covers only the stubbed cases.
        actual.createStructuredAgentSessionForWorktree as unknown as Parameters<
          typeof createStructured.mockImplementationOnce
        >[0]
      )
      const { prompt: _prompt, ...withoutMessage } = ACCEPTED
      try {
        await accept(runtime, {
          ...(withMessage ? ACCEPTED : withoutMessage),
          agent: 'codex',
          sessionId
        })
        await preparing.promise
        noteStructuredAgentSessionClose(sessionId, false)
        release.resolve()
        await expect(status(runtime, 5_000)).resolves.toEqual({
          state: 'failed',
          code: 'agent_launch_tab_closed'
        })
        expect(rig.store.getRecord(sessionId)).toBeNull()
        expect(rig.adapter.acquire).not.toHaveBeenCalled()
        expect(rig.adapter.dispatch).not.toHaveBeenCalled()
        expect(runtime.createTerminal).not.toHaveBeenCalled()
      } finally {
        release.resolve()
        setStructuredAgentSessionHost(null)
        await rig.dispose()
      }
    }
  )

  it('spawns no terminal when the close lands during its account and launch preparation', async () => {
    const runtime = hostRuntime(undefined, { createSupport: { supported: false, reason: 'agent' } })
    const preparing = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const dispatched = vi.fn()
    // The runtime's own order: preparation awaits, then an abort check, then the spawn leaves.
    runtime.createTerminal.mockImplementationOnce(async (_selector, options) => {
      preparing.resolve()
      await release.promise
      const opts = options as { signal?: AbortSignal; onPtySpawnDispatched?: () => void }
      if (opts.signal?.aborted) {
        throw new Error('client_disconnected')
      }
      opts.onPtySpawnDispatched?.()
      dispatched()
      return { handle: 'term_1' }
    })
    await accept(runtime)
    await preparing.promise
    noteStructuredAgentSessionClose(SESSION_ID, false)
    release.resolve()
    await expect(status(runtime, 5_000)).resolves.toEqual({
      state: 'failed',
      code: 'agent_launch_tab_closed'
    })
    expect(dispatched).not.toHaveBeenCalled()
    expect(runtime.pasteStartupDraftWhenReady).not.toHaveBeenCalled()
  })
})
