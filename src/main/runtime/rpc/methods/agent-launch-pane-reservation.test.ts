/**
 * The pane a caller reserves for the terminal `agent.launch` creates.
 *
 * A client that places its own tabs mints the pane id first and records where the tab should go
 * under it; the host still reveals the tab, and the renderer finds the placement by that id. So the
 * only thing that crosses the wire is identity — and the outcome's `paneKey` says which pane really
 * exists, so a caller whose reservation lost (older host, replay, structured route) can tell.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { RpcDispatcher } from '../dispatcher'
import {
  CAPABLE_CLIENT,
  STRUCTURED_PREFERENCE,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub as RuntimeStub
} from './agent-launch.test-fixture'

vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: async () => ({
    ok: true,
    value: { sessionId: 'sess-1' }
  })
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

/** No structured preference, so every launch here settles as a terminal unless it says otherwise. */
const TERMINAL_ONLY = {}

const EXISTING_LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}

async function launch(params: unknown, runtime: RuntimeStub, context: Partial<RpcContext> = {}) {
  const parsed = AGENT_LAUNCH.params.safeParse(params)
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? 'invalid')
  }
  return AGENT_LAUNCH.handler(parsed.data, rpcContext(runtime, { ...CAPABLE_CLIENT, ...context }))
}

function terminalOptions(runtime: RuntimeStub): Record<string, unknown> {
  return runtime.createTerminal.mock.calls[0]?.[1] ?? {}
}

describe('a launch into an existing workspace', () => {
  it('creates the terminal under the pane the caller reserved', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...EXISTING_LAUNCH, paneKey: PANE_KEY }, runtime)

    expect(terminalOptions(runtime)).toMatchObject({
      tabId: TAB_ID,
      leafId: LEAF_ID,
      requireFreshPane: true
    })
  })

  it('leaves the pane to the runtime when the caller reserved none', async () => {
    // Every shipped caller sends nothing; its options must not gain a key.
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch(EXISTING_LAUNCH, runtime)

    expect(terminalOptions(runtime)).not.toHaveProperty('tabId')
    expect(terminalOptions(runtime)).not.toHaveProperty('leafId')
    expect(terminalOptions(runtime)).not.toHaveProperty('requireFreshPane')
  })

  it('keeps the reservation through a downgrade from structured to terminal', async () => {
    const runtime = runtimeStub({
      settings: STRUCTURED_PREFERENCE,
      createSupport: { supported: false, reason: 'wsl' }
    })

    const result = await launch({ ...EXISTING_LAUNCH, paneKey: PANE_KEY }, runtime)

    expect(result.receipt).toMatchObject({ mode: 'terminal' })
    expect(terminalOptions(runtime)).toMatchObject({ tabId: TAB_ID, leafId: LEAF_ID })
  })

  it('creates no terminal for a launch the host settles as a chat', async () => {
    // The reservation simply goes unused; the structured outcome tells the caller to burn it.
    const runtime = runtimeStub({ settings: STRUCTURED_PREFERENCE })

    const result = await launch({ ...EXISTING_LAUNCH, paneKey: PANE_KEY }, runtime)

    expect(result.outcome.kind).toBe('structured')
    expect(runtime.createTerminal).not.toHaveBeenCalled()
  })

  it('creates no terminal when it reuses a running one', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    const result = await launch(
      { ...EXISTING_LAUNCH, paneKey: PANE_KEY, reuseTerminal: { handle: 'term_live' } },
      runtime
    )

    expect(runtime.createTerminal).not.toHaveBeenCalled()
    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_live' })
  })
})

describe('a reserved pane that is already live', () => {
  // The runtime attaches to a live pane rather than spawning, which is right for `terminal.create`
  // but here would report an agent that never started and paste into whatever runs there.
  it('refuses the launch and delivers no prompt', async () => {
    // An agent that takes its prompt as a paste after start, so a missing refusal would reach it.
    const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalPaneAlreadyLive: true })
    const prompt = {
      waitForTerminal: vi.fn(async () => ({ satisfied: true })),
      sendTerminalAgentPrompt: vi.fn(async () => true)
    }
    Object.assign(runtime, prompt)

    await expect(
      launch(
        {
          ...EXISTING_LAUNCH,
          agent: 'aider',
          paneKey: PANE_KEY,
          prompt: { text: 'hi', delivery: 'submit' }
        },
        runtime
      )
    ).rejects.toThrow('agent_launch_pane_already_live')
    expect(prompt.waitForTerminal).not.toHaveBeenCalled()
    expect(prompt.sendTerminalAgentPrompt).not.toHaveBeenCalled()
  })

  it('launches normally when the runtime spawned a fresh pane', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalPaneKey: PANE_KEY })

    const result = await launch({ ...EXISTING_LAUNCH, paneKey: PANE_KEY }, runtime)

    expect(result.outcome).toEqual({ kind: 'terminal', handle: 'term_1', paneKey: PANE_KEY })
  })
})

describe('a launch that creates its workspace', () => {
  it('carries the reservation to the startup terminal the create spawns', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...CREATE_LAUNCH, paneKey: PANE_KEY }, runtime)

    expect(runtime.createManagedWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ startupPaneKey: PANE_KEY })
    )
  })

  it('sends no startup pane when the caller reserved none', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch(CREATE_LAUNCH, runtime)

    expect(runtime.createManagedWorktree.mock.calls[0]?.[0]).not.toHaveProperty('startupPaneKey')
  })

  it('keeps the reservation out of the worktree.create payload', async () => {
    // A sibling of the payload, like the other startup inputs: it names this launch's pane, not
    // something a `worktree.create` caller can ask for.
    const runtime = runtimeStub({ settings: TERMINAL_ONLY })

    await launch({ ...CREATE_LAUNCH, paneKey: PANE_KEY }, runtime)

    expect(runtime.createManagedWorktree.mock.calls[0]?.[0]).not.toHaveProperty('paneKey')
  })
})

describe('the reservation at the wire', () => {
  it.each([
    ['no leaf', TAB_ID],
    ['a leaf that is not a UUID', `${TAB_ID}:leaf-1`],
    ['an empty tab id', `:${LEAF_ID}`],
    ['an extra separator', `${TAB_ID}:${LEAF_ID}:x`]
  ])('refuses a pane key with %s rather than letting the runtime mint silently', (_, paneKey) => {
    expect(AGENT_LAUNCH.params.safeParse({ ...EXISTING_LAUNCH, paneKey }).success).toBe(false)
  })

  it.each([
    ['a tab id the runtime would trim', ` ${TAB_ID}:${LEAF_ID}`],
    ['a tab id that trims to nothing', `   :${LEAF_ID}`],
    ['a tab id longer than the spawn reservation keys', `${'t'.repeat(513)}:${LEAF_ID}`]
  ])('refuses a pane key with %s, which the runtime would not adopt verbatim', (_, paneKey) => {
    expect(AGENT_LAUNCH.params.safeParse({ ...EXISTING_LAUNCH, paneKey }).success).toBe(false)
  })

  it('accepts a well-formed pane key', () => {
    expect(AGENT_LAUNCH.params.safeParse({ ...EXISTING_LAUNCH, paneKey: PANE_KEY }).success).toBe(
      true
    )
  })
})

describe('a live-pane refusal under a named operation', () => {
  // The ledger admits against `Date.now()`, so the id must be dated now.
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000bb`
  let directory: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-pane-'))
    store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `deps.store` is the only member `agent.launch` reads, and a member it omits throws on call.
    setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
  })

  afterEach(async () => {
    setStructuredAgentSessionHost(null)
    await rm(directory, { recursive: true, force: true })
  })

  function outcomeOf(operationId: string) {
    return store.listOperationRows().find((row) => row.operationId === operationId)?.outcome
  }

  async function dispatch(runtime: RuntimeStub, method: string, params: unknown) {
    const dispatcher = new RpcDispatcher({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every runtime method reached by agent.launch and dispatcher metadata.
      runtime: { ...runtime, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
      methods: AGENT_LAUNCH_METHODS
    })
    return dispatcher.dispatch({ id: 'request-1', authToken: 'token', method, params })
  }

  it('records the refusal as a failure, so a retry is answered rather than left unknown', async () => {
    const params = { ...EXISTING_LAUNCH, paneKey: PANE_KEY, operationId: OPERATION_ID }
    await expect(
      launch(params, runtimeStub({ settings: TERMINAL_ONLY, terminalPaneAlreadyLive: true }))
    ).rejects.toThrow('agent_launch_pane_already_live')
    expect(outcomeOf(OPERATION_ID)).toMatchObject({
      status: 'failed',
      code: 'agent_launch_pane_already_live'
    })

    const retry = runtimeStub({ settings: TERMINAL_ONLY })
    await expect(launch(params, retry)).rejects.toThrow('agent_launch_pane_already_live')
    expect(retry.createTerminal).not.toHaveBeenCalled()
  })

  it('answers agent.launchReplay with the refusal code, not operation_unknown', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalPaneAlreadyLive: true })
    const params = AGENT_LAUNCH_REPLAY.params.parse({
      ...EXISTING_LAUNCH,
      paneKey: PANE_KEY,
      operationId: OPERATION_ID
    })

    const response = await dispatch(runtime, 'agent.launchReplay', params)

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_launch_pane_already_live' }
    })
    expect(outcomeOf(OPERATION_ID)).toMatchObject({ status: 'failed' })
  })

  it('leaves a create-worktree launch unknown, because its workspace was already created', async () => {
    const runtime = runtimeStub({ settings: TERMINAL_ONLY, terminalPaneAlreadyLive: true })
    // No startup terminal came back, so the launch builds its own in the new workspace.
    runtime.createManagedWorktree.mockResolvedValueOnce({
      worktree: { id: 'wt-new' },
      startupTerminal: undefined
    })
    const params = AGENT_LAUNCH_REPLAY.params.parse({
      ...CREATE_LAUNCH,
      paneKey: PANE_KEY,
      operationId: OPERATION_ID
    })

    const response = await dispatch(runtime, 'agent.launchReplay', params)

    expect(runtime.createTerminal).toHaveBeenCalledTimes(1)
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'agent_session_operation_unknown' }
    })
    expect(outcomeOf(OPERATION_ID)?.status).toBe('unknown')
  })
})
