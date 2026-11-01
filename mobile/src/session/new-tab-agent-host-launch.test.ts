import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-launch-runtime-capability'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { launchNewTabAgentThroughHost } from './new-tab-agent-host-launch'
import type { PendingSessionSelection } from './pending-session-selection'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) }
}))
vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn(), triggerError: vi.fn() }))

const LAUNCH_CAPABILITIES = [
  'agent.launch.v2',
  'agent.launch.replay.v1',
  'agent.launch.replay-required.v1',
  AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
]

function ok(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

const launchReply = ok({
  outcome: { kind: 'terminal', handle: 'term_7' },
  worktreeId: 'workspace-1',
  receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'd' }
})

function scriptedClient(agents: readonly string[], statusCapabilities?: readonly string[]) {
  const calls: Array<{ method: string; params: unknown }> = []
  const sendRequest = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
    if (method === 'status.get') {
      if (!statusCapabilities) {
        throw new Error('unexpected request: status.get')
      }
      return ok({ capabilities: [...statusCapabilities] })
    }
    if (method === 'agentSession.agents') {
      return ok({ agents: agents.map((agent) => ({ agent, capabilities: {} })) })
    }
    if (method === 'agent.launchReplay') {
      return launchReply
    }
    throw new Error(`unexpected request: ${method}`)
  })
  const rpc: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { client: rpc, calls }
}

async function launch(
  agent: TuiAgent,
  hostCapabilities: readonly string[],
  agents: readonly string[] = ['antigravity', 'claude'],
  statusCapabilities?: readonly string[]
) {
  const { client, calls } = scriptedClient(agents, statusCapabilities)
  const pendingSelectionRef: { current: PendingSessionSelection | null } = { current: null }
  const launched = await launchNewTabAgentThroughHost({
    client,
    hostCapabilities,
    worktreeId: 'workspace-1',
    agent,
    options: undefined,
    lock: 'lock-1',
    pendingSelectionRef,
    fetchSessionTabs: async () => {},
    getSessionTabs: () => [],
    showToast: () => {},
    reportCreateFailure: () => {},
    setCreateError: () => {}
  })
  const params = calls.find((call) => call.method === 'agent.launchReplay')?.params
  return { launched, params, methods: calls.map((call) => call.method) }
}

describe('launchNewTabAgentThroughHost chat surface', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('chat')
  })

  it('keeps Hermes in a terminal for the transcript overlay regardless of the host default', async () => {
    const { params } = await launch('hermes', LAUNCH_CAPABILITIES)
    expect(params).toMatchObject({ agent: 'hermes', surface: 'terminal' })
  })

  it('uses legacy terminal creation when the host cannot choose a launch surface', async () => {
    const { launched, methods } = await launch('hermes', ['agent.launch.v2'])
    expect(launched).toBe(false)
    expect(methods).toEqual([])
  })

  it('asks a headless host to start Antigravity as chat when Chat UI is on', async () => {
    const { launched, params, methods } = await launch('antigravity', LAUNCH_CAPABILITIES)
    expect(launched).toBe(true)
    expect(methods).toEqual(['agentSession.agents', 'agent.launchReplay'])
    expect(params).toMatchObject({ agent: 'antigravity', surface: 'chat' })
  })

  it('leaves Claude on the transcript overlay', async () => {
    const { params } = await launch('claude', LAUNCH_CAPABILITIES)
    expect(params).toMatchObject({ agent: 'claude' })
    expect(params).not.toHaveProperty('surface')
  })

  it('does not request chat for an agent the host did not register', async () => {
    const { params } = await launch('gemini', LAUNCH_CAPABILITIES, ['antigravity'])
    expect(params).toMatchObject({ agent: 'gemini' })
    expect(params).not.toHaveProperty('surface')
  })

  it('leaves Antigravity on the terminal when Chat UI is off, like the others', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('terminal')
    const { params } = await launch('antigravity', LAUNCH_CAPABILITIES)
    expect(params).toMatchObject({ agent: 'antigravity' })
    expect(params).not.toHaveProperty('surface')
  })

  it('asks for Antigravity chat when Chat UI is on', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('chat')
    const { params, methods } = await launch('antigravity', LAUNCH_CAPABILITIES)
    expect(methods).toEqual(['agentSession.agents', 'agent.launchReplay'])
    expect(params).toMatchObject({ agent: 'antigravity', surface: 'chat' })
  })

  it('leaves Claude on the terminal when Chat UI is off', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('terminal')
    const { params } = await launch('claude', LAUNCH_CAPABILITIES)
    expect(params).not.toHaveProperty('surface')
  })

  it('leaves Antigravity on the terminal when a fresh install has not stored Chat UI', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)
    const { params } = await launch('antigravity', LAUNCH_CAPABILITIES)
    expect(params).not.toHaveProperty('surface')
  })

  it('does not ask for chat when the host cannot choose a surface', async () => {
    const { params, methods } = await launch('antigravity', [
      'agent.launch.v2',
      'agent.launch.replay.v1',
      'agent.launch.replay-required.v1'
    ])
    expect(methods).toEqual(['agent.launchReplay'])
    expect(params).not.toHaveProperty('surface')
  })

  it('starts Antigravity chat from a fresh status when the gate list is still empty', async () => {
    const { launched, params, methods } = await launch(
      'antigravity',
      [],
      ['antigravity'],
      LAUNCH_CAPABILITIES
    )
    expect(launched).toBe(true)
    expect(methods).toEqual(['status.get', 'agentSession.agents', 'agent.launchReplay'])
    expect(params).toMatchObject({ agent: 'antigravity', surface: 'chat' })
  })

  it('does not launch when that fresh status cannot be read', async () => {
    const { launched, params, methods } = await launch('antigravity', [])
    expect(launched).toBe(false)
    expect(methods).toEqual(['status.get'])
    expect(params).toBeUndefined()
  })
})
