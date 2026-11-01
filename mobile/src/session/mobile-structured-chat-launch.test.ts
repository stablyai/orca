import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-launch-runtime-capability'
import { AGENT_SESSION_AGENTS_METHOD } from '../../../src/shared/agent-session/agent-session-registered-agents'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  loadMobileStructuredChatLaunchContext,
  mobileStructuredChatLaunchSurface,
  withMobileStructuredChatLaunch,
  type MobileStructuredChatLaunchContext
} from './mobile-structured-chat-launch'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) }
}))

const chatHost: MobileStructuredChatLaunchContext = {
  defaultView: 'chat',
  registeredAgents: ['hermes', 'claude'],
  canRequestSurface: true
}

const registered = (agent: string) => ({ agent, capabilities: {} })

function ok(result: unknown): RpcResponse {
  return { id: 'agents', ok: true, result, _meta: { runtimeId: 'r' } }
}

function client(sendRequest: RpcClient['sendRequest']): RpcClient {
  return {
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
}

describe('mobileStructuredChatLaunchSurface', () => {
  it('asks for chat only for a registered agent the transcript overlay does not cover', () => {
    expect(mobileStructuredChatLaunchSurface('hermes', chatHost)).toBe('chat')
    expect(mobileStructuredChatLaunchSurface('claude', chatHost)).toBeUndefined()
    expect(mobileStructuredChatLaunchSurface('gemini', chatHost)).toBeUndefined()
    expect(
      mobileStructuredChatLaunchSurface('hermes', { ...chatHost, defaultView: 'terminal' })
    ).toBeUndefined()
    expect(
      mobileStructuredChatLaunchSurface('hermes', { ...chatHost, canRequestSurface: false })
    ).toBeUndefined()
    expect(mobileStructuredChatLaunchSurface('hermes', null)).toBeUndefined()
  })

  it('marks only those new-tab rows as opening in chat', () => {
    expect(
      withMobileStructuredChatLaunch(
        [
          { agent: 'hermes', label: 'Hermes' },
          { agent: 'claude', label: 'Claude' }
        ],
        chatHost
      )
    ).toEqual([
      { agent: 'hermes', label: 'Hermes', opensAsChat: true },
      { agent: 'claude', label: 'Claude' }
    ])
  })
})

describe('loadMobileStructuredChatLaunchContext', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)
  })

  it('reads Chat UI and the host registry when the host can launch a surface', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('chat')
    const sendRequest = vi.fn(async (method: string) => {
      expect(method).toBe(AGENT_SESSION_AGENTS_METHOD)
      return ok({ agents: [registered('hermes'), registered('claude')] })
    })
    const context = await loadMobileStructuredChatLaunchContext({
      client: client(sendRequest),
      hostCapabilities: [
        AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
      ]
    })
    expect(context).toEqual(chatHost)
  })

  it('does not ask an older host for its registry', async () => {
    const sendRequest = vi.fn()
    const context = await loadMobileStructuredChatLaunchContext({
      client: client(sendRequest),
      hostCapabilities: ['agent.launch.v2']
    })
    expect(sendRequest).not.toHaveBeenCalled()
    expect(context).toEqual({
      defaultView: 'terminal',
      registeredAgents: [],
      canRequestSurface: false
    })
  })

  it('keeps the launch when the registry cannot be read', async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('offline')
    })
    const context = await loadMobileStructuredChatLaunchContext({
      client: client(sendRequest),
      hostCapabilities: [
        AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
      ]
    })
    expect(context.registeredAgents).toEqual([])
    expect(context.canRequestSurface).toBe(true)
    expect(mobileStructuredChatLaunchSurface('hermes', context)).toBeUndefined()
  })
})
