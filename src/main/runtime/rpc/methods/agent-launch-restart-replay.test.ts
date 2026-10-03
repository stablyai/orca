/**
 * A launch's record across a host restart, against the real durable ledger.
 *
 * The record is written twice: once when the surface exists and once when the prompt's fate is
 * known. A host that dies at any point leaves the replay a truthful answer — the running agent once
 * its surface is recorded, an honest "unknown" before — and never a second agent. A "restart" here
 * is what a new process sees: the store reopened from disk and a runtime with no in-flight launches.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch-runtime-capability'
import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { AgentSessionOperationRow } from '../../../../shared/agent-session-operation-ledger'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import {
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const deliverTerminalPrompt = vi.hoisted(() =>
  vi.fn(async (_args: { handle: string }): Promise<boolean> => true)
)
vi.mock('./agent-launch-terminal-prompt', () => ({
  deliverTerminalAgentLaunchPrompt: deliverTerminalPrompt
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

// The ledger admits against `Date.now()`, so the id must be dated now.
const OPERATION_ID = `${Date.now()}-000000000000000000000000000000ee`
const PANE_KEY = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301'
// No structured preference: every launch here is a terminal agent, the surface a restart outlives.
const TERMINAL_ONLY = {}
const PROMPTED_LAUNCH = {
  agent: 'claude',
  target: { kind: 'existing', worktree: 'id:wt-7' },
  prompt: { text: 'fix the failing test', delivery: 'submit' },
  operationId: OPERATION_ID
}
const PHONE: Partial<RpcContext> = {
  clientKind: 'mobile',
  pairedDeviceId: 'device-1',
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}
/** Exactly what the desktop's `runtime:call` handler hands the dispatcher. */
const DESKTOP_IPC = {
  clientId: 'desktop-renderer',
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime' as const,
  clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY]
}

let directory: string
let store: AgentSessionRecordStore

function hostRuntime() {
  // A phone's launch into an existing workspace also moves the phone's own view to the new tab.
  return Object.assign(runtimeStub({ settings: TERMINAL_ONLY, terminalPaneKey: PANE_KEY }), {
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}

function launch(
  runtime: AgentLaunchRuntimeStub,
  params: unknown = PROMPTED_LAUNCH,
  context: Partial<RpcContext> = PHONE
): Promise<AgentLaunchResult> {
  return AGENT_LAUNCH_REPLAY.handler(
    AGENT_LAUNCH_REPLAY.params.parse(params),
    rpcContext(runtime, context)
  )
}

/** A new process: the store reread from disk, and nothing in flight. */
async function restartHost(): Promise<void> {
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
}

function row(callerKey = 'device-1'): AgentSessionOperationRow | null {
  return store.getOperationRow(callerKey, OPERATION_ID)
}

/** The first write is fired, not awaited, so it lands a moment after the tab is published. */
async function untilRecorded(status: AgentSessionOperationRow['outcome']['status']): Promise<void> {
  const deadline = Date.now() + 2_000
  while (row()?.outcome.status !== status) {
    if (Date.now() > deadline) {
      throw new Error(`the launch row never reached ${status}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The store commits in order, so a write queued now lands after every write already fired. */
async function ledgerWritesQueuedBefore(ledger: AgentSessionRecordStore): Promise<void> {
  await ledger.recordOperationOutcome({
    callerKey: 'no-such-caller',
    operationId: OPERATION_ID,
    outcome: { status: 'unknown' }
  })
}

function dispatcherFor(runtime: AgentLaunchRuntimeStub): RpcDispatcher {
  return new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method agent.launch reaches, plus the id the dispatcher stamps on replies.
    runtime: { ...runtime, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
    methods: AGENT_LAUNCH_METHODS
  })
}

beforeEach(async () => {
  deliverTerminalPrompt.mockReset()
  deliverTerminalPrompt.mockResolvedValue(true)
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-restart-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  setAgentLaunchRecordStore(null)
  await rm(directory, { recursive: true, force: true })
})

describe('a host restart mid-launch', () => {
  it('finds the running agent when the host died while its prompt waited for readiness', async () => {
    // The paste waits for the agent forever: the host dies first.
    let waiting: () => void = () => {}
    const readinessWait = new Promise<void>((resolve) => {
      waiting = resolve
    })
    deliverTerminalPrompt.mockImplementationOnce(() => {
      waiting()
      return new Promise<boolean>(() => {})
    })
    const dying = hostRuntime()
    void launch(dying)
    await readinessWait
    await ledgerWritesQueuedBefore(store)

    await restartHost()
    const restarted = hostRuntime()
    const replayed = await launch(restarted)

    expect(replayed).toEqual({
      outcome: { kind: 'terminal', handle: 'term_1', paneKey: PANE_KEY },
      worktreeId: 'wt-7',
      receipt: expect.objectContaining({ mode: 'terminal' }),
      // The dead host never pasted it, and saying so lets the caller keep the text.
      prompt: { delivery: 'submit', outcome: 'not-delivered' }
    })
    expect(restarted.createTerminal).not.toHaveBeenCalled()
    expect(dying.createTerminal).toHaveBeenCalledOnce()
    expect(deliverTerminalPrompt).toHaveBeenCalledOnce()
  })

  it('stays unknown when the host died before the surface was recorded', async () => {
    const dying = hostRuntime()
    let spawnRequested: () => void = () => {}
    const spawning = new Promise<void>((resolve) => {
      spawnRequested = resolve
    })
    dying.createTerminal.mockImplementationOnce(() => {
      spawnRequested()
      return new Promise(() => {})
    })
    void launch(dying)
    await spawning

    await restartHost()
    const restarted = hostRuntime()

    // A pane may exist that nothing recorded; "unknown" is the truthful answer, never a relaunch.
    await expect(launch(restarted)).rejects.toThrow('agent_session_operation_unknown')
    expect(row()?.outcome.status).toBe('unknown')
    expect(restarted.createTerminal).not.toHaveBeenCalled()
  })

  it('replays the final answer when the host died after the prompt landed', async () => {
    const first = await launch(hostRuntime())
    expect(first.prompt).toEqual({ delivery: 'submit', outcome: 'handed-to-terminal' })

    await restartHost()
    const restarted = hostRuntime()

    await expect(launch(restarted)).resolves.toEqual(first)
    expect(restarted.createTerminal).not.toHaveBeenCalled()
    expect(deliverTerminalPrompt).toHaveBeenCalledOnce()
  })

  it('lets the final write replace the first, never the other way round', async () => {
    let releasePaste: (pasted: boolean) => void = () => {}
    deliverTerminalPrompt.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releasePaste = resolve
        })
    )
    const running = launch(hostRuntime())
    await untilRecorded('succeeded')
    releasePaste(true)
    await running

    await restartHost()
    const outcome = row()?.outcome
    expect(outcome?.status === 'succeeded' && outcome.launch).toMatchObject({
      prompt: { outcome: 'handed-to-terminal' }
    })
  })
})

describe('a reply lost three times', () => {
  it('starts one agent, and every retry gets its answer', async () => {
    const host = hostRuntime()
    const first = await launch(host)
    // Lost once and twice on the same host, then a third time across a restart.
    const second = await launch(host)
    const third = await launch(host)
    await restartHost()
    const afterRestart = hostRuntime()
    const fourth = await launch(afterRestart)

    expect([second, third, fourth]).toEqual([first, first, first])
    expect(host.createTerminal).toHaveBeenCalledOnce()
    expect(afterRestart.createTerminal).not.toHaveBeenCalled()
    expect(deliverTerminalPrompt).toHaveBeenCalledOnce()
  })

  it('starts one agent when three retries arrive while the first is still running', async () => {
    let releasePaste: (pasted: boolean) => void = () => {}
    deliverTerminalPrompt.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releasePaste = resolve
        })
    )
    const host = hostRuntime()
    const attempts = [launch(host), launch(host), launch(host)]
    await untilRecorded('succeeded')
    releasePaste(true)
    const [first, ...retries] = await Promise.all(attempts)

    expect(retries).toEqual([first, first])
    expect(host.createTerminal).toHaveBeenCalledOnce()
  })
})

describe('the desktop launches replay-safely', () => {
  it('admits the desktop window under its own host-assigned identity and replays its id', async () => {
    const host = hostRuntime()
    const request = {
      id: 'request-1',
      authToken: 'desktop-ipc',
      method: 'agent.launchReplay',
      params: PROMPTED_LAUNCH
    }

    const first = await dispatcherFor(host).dispatch(request, DESKTOP_IPC)
    const replayed = await dispatcherFor(host).dispatch(request, DESKTOP_IPC)

    expect(first).toMatchObject({ ok: true, result: { outcome: { kind: 'terminal' } } })
    expect(replayed).toMatchObject({ ok: true, result: first.ok ? first.result : null })
    expect(host.createTerminal).toHaveBeenCalledOnce()
    expect(row('trusted-local:desktop')?.outcome.status).toBe('succeeded')
  })

  it('opens the ledger alone, never the chat host, to admit a terminal launch', async () => {
    const host = hostRuntime()

    await launch(host)

    expect(host.openAgentSessionRecordStore).toHaveBeenCalled()
    expect(host.ensureStructuredAgentSessionHost).not.toHaveBeenCalled()
  })
})

describe('a caller cannot claim an identity', () => {
  it('keys a paired device by its authenticated subject whatever its params say', async () => {
    const host = hostRuntime()
    const response = await new Promise<string>((resolve) => {
      void dispatcherFor(host).dispatchStreaming(
        {
          id: 'request-1',
          authToken: 'device-token',
          method: 'agent.launchReplay',
          params: {
            ...PROMPTED_LAUNCH,
            caller: DESKTOP_RPC_CALLER,
            callerKey: 'trusted-local:desktop',
            pairedDeviceId: 'device-2'
          }
        },
        resolve,
        { ...PHONE, clientId: 'device-token' }
      )
    })

    expect(JSON.parse(response)).toMatchObject({ ok: true })
    expect(store.listOperationRows().map((entry) => entry.callerKey)).toEqual(['device-1'])
  })

  it('refuses replay safety to a transport that cannot name its caller', async () => {
    const host = hostRuntime()

    const response = await dispatcherFor(host).dispatch(
      {
        id: 'request-1',
        authToken: 'token',
        method: 'agent.launchReplay',
        params: { ...PROMPTED_LAUNCH, caller: DESKTOP_RPC_CALLER }
      },
      { clientKind: 'runtime', clientCapabilities: [AGENT_LAUNCH_RUNTIME_CAPABILITY] }
    )

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_identity_required' }
    })
    expect(host.createTerminal).not.toHaveBeenCalled()
    expect(store.listOperationRows()).toHaveLength(0)
  })
})

describe('the ledger stays bounded', () => {
  it('keeps one row per launch, retained from admission, across both writes', async () => {
    let releasePaste: (pasted: boolean) => void = () => {}
    deliverTerminalPrompt.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releasePaste = resolve
        })
    )
    const running = launch(hostRuntime())
    await untilRecorded('succeeded')
    const afterFirstWrite = row()
    releasePaste(true)
    await running

    expect(store.listOperationRows()).toHaveLength(1)
    expect(row()?.expiresAt).toBe(afterFirstWrite?.expiresAt)
    expect(row()?.recordedAt).toBe(afterFirstWrite?.recordedAt)
  })

  it('holds the desktop to the same per-caller cap as every other caller', async () => {
    const now = Date.now()
    for (let index = 0; index < 512; index += 1) {
      await store.admitOperation({
        callerKey: 'trusted-local:desktop',
        operationId: `${now}-${index.toString(16).padStart(32, '0')}`,
        fingerprint: 'fp-seeded',
        now
      })
    }
    const host = hostRuntime()

    await expect(launch(host, PROMPTED_LAUNCH, { ...DESKTOP_IPC })).rejects.toThrow(
      'agent_session_operation_capacity'
    )
    expect(host.createTerminal).not.toHaveBeenCalled()
    // Another caller's namespace is not starved by it.
    await expect(launch(host)).resolves.toMatchObject({ outcome: { kind: 'terminal' } })
  })
})
