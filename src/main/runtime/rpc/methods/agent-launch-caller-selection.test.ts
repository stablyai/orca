/**
 * A launch from a paired client moves that client's view to the new tab and nobody else's: the view
 * intent belongs to the connection that asked. In-process callers and workspace-creating launches
 * keep today's behaviour.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../agent-session-record-store'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import {
  CAPABLE_CLIENT,
  STRUCTURED_PREFERENCE,
  methodNamed,
  rpcContext,
  runtimeStub,
  type AgentLaunchRuntimeStub
} from './agent-launch.test-fixture'

const createStructuredSession = vi.hoisted(() => vi.fn())
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructuredSession
}))

const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
const AGENT_LAUNCH = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
const AGENT_LAUNCH_REPLAY = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`
const EXISTING_LAUNCH = { agent: 'claude', target: { kind: 'existing', worktree: 'id:wt-7' } }
const CREATE_LAUNCH = {
  agent: 'claude',
  target: { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'task' } }
}
const CALLER = 'device-1'

function selectionRuntime(options: Parameters<typeof runtimeStub>[0]) {
  return Object.assign(runtimeStub(options), {
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}

async function launch(
  params: unknown,
  runtime: AgentLaunchRuntimeStub,
  context: Partial<RpcContext> = CAPABLE_CLIENT
) {
  return AGENT_LAUNCH.handler(AGENT_LAUNCH.params.parse(params), rpcContext(runtime, context))
}

function chatActivation(): unknown {
  return createStructuredSession.mock.calls[0]?.[0]?.activate
}

beforeEach(() => {
  createStructuredSession
    .mockReset()
    .mockResolvedValue({ ok: true, value: { sessionId: 'sess-1' } })
})

describe('a paired client launching into an existing workspace', () => {
  it("selects the new terminal as that client's tab only", async () => {
    const runtime = selectionRuntime({ settings: {}, terminalPaneKey: PANE_KEY })

    await launch(EXISTING_LAUNCH, runtime)

    expect(runtime.selectCreatedMobileSessionTabForClient).toHaveBeenCalledExactlyOnceWith(
      'wt-7',
      expect.objectContaining({ tabId: TAB_ID, leafId: LEAF_ID }),
      CALLER
    )
  })

  it('publishes the chat without activating it for everyone, then selects it by session for the caller', async () => {
    const runtime = selectionRuntime({ settings: STRUCTURED_PREFERENCE })

    const result = await launch(EXISTING_LAUNCH, runtime)

    expect(result.outcome.kind).toBe('structured')
    expect(chatActivation()).toBe(false)
    expect(runtime.selectCreatedMobileSessionTabForClient).toHaveBeenCalledExactlyOnceWith(
      'wt-7',
      { sessionId: 'sess-1' },
      CALLER
    )
  })

  it('still reports the launch when selecting its tab fails', async () => {
    const runtime = selectionRuntime({ settings: {}, terminalPaneKey: PANE_KEY })
    runtime.selectCreatedMobileSessionTabForClient.mockImplementationOnce(() => {
      throw new Error('selection store unavailable')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await launch(EXISTING_LAUNCH, runtime)

    expect(result.outcome).toMatchObject({ kind: 'terminal', handle: 'term_1' })
    warn.mockRestore()
  })

  it('selects nothing when the runtime reported no pane for the terminal', async () => {
    const runtime = selectionRuntime({ settings: {} })

    await launch(EXISTING_LAUNCH, runtime)

    expect(runtime.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })
})

describe('launches that keep the host-wide behaviour', () => {
  it('an in-process caller activates the chat and selects nothing per client', async () => {
    const runtime = selectionRuntime({ settings: STRUCTURED_PREFERENCE })

    await launch(EXISTING_LAUNCH, runtime, {})

    expect(chatActivation()).toBe(true)
    expect(runtime.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })

  it('a workspace-creating launch from a paired client keeps the create navigation', async () => {
    const runtime = selectionRuntime({ settings: STRUCTURED_PREFERENCE })

    await launch(CREATE_LAUNCH, runtime)

    expect(chatActivation()).toBe(true)
    expect(runtime.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })
})

describe('a replayed launch', () => {
  // The ledger admits against `Date.now()`, so the id must be dated now.
  const OPERATION_ID = `${Date.now()}-000000000000000000000000000000dd`
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-caller-'))
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `deps.store` is the only member `agent.launch` reads, and a member it omits throws on call.
    setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
  })

  afterEach(async () => {
    setStructuredAgentSessionHost(null)
    await rm(directory, { recursive: true, force: true })
  })

  it('answers from the record without moving the caller again', async () => {
    const params = AGENT_LAUNCH_REPLAY.params.parse({
      ...EXISTING_LAUNCH,
      operationId: OPERATION_ID
    })
    const first = selectionRuntime({ settings: {}, terminalPaneKey: PANE_KEY })
    await AGENT_LAUNCH_REPLAY.handler(params, rpcContext(first, CAPABLE_CLIENT))
    expect(first.selectCreatedMobileSessionTabForClient).toHaveBeenCalledOnce()

    const replay = selectionRuntime({ settings: {}, terminalPaneKey: PANE_KEY })
    await AGENT_LAUNCH_REPLAY.handler(params, rpcContext(replay, CAPABLE_CLIENT))

    expect(replay.createTerminal).not.toHaveBeenCalled()
    expect(replay.selectCreatedMobileSessionTabForClient).not.toHaveBeenCalled()
  })
})
