import AsyncStorage from '@react-native-async-storage/async-storage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import pageAsyncStorage, {
  publishPageStorage,
  refreshPageTerminalShortcuts
} from '../mobile-web-shell/bridge/page-async-storage'
import { AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY } from '../../../src/shared/agent-launch-runtime-capability'
import { AGENT_SESSION_AGENTS_METHOD } from '../../../src/shared/agent-session/agent-session-registered-agents'
import { STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY } from '../../../src/shared/agent-session/structured-agent-session-surface-capabilities'
import { HERMES_TRANSCRIPT_RUNTIME_CAPABILITY } from '../../../src/shared/native-chat/native-chat-hermes-capability'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  loadMobileStructuredChatLaunchContext,
  readMobileStructuredChatLaunchContext,
  mobileNewTabHostLaunchSurface,
  mobileStructuredChatLaunchSurface,
  withMobileStructuredChatLaunch,
  type MobileStructuredChatLaunchContext
} from './mobile-structured-chat-launch'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined)
  }
}))

const chatHost: MobileStructuredChatLaunchContext = {
  defaultView: 'chat',
  registeredAgents: ['antigravity', 'claude'],
  canRequestSurface: true,
  hostCapabilities: [
    AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
    STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
  ]
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
    expect(mobileStructuredChatLaunchSurface('antigravity', chatHost)).toBe('chat')
    expect(
      mobileStructuredChatLaunchSurface('hermes', {
        ...chatHost,
        registeredAgents: ['hermes']
      })
    ).toBeUndefined()
    expect(mobileStructuredChatLaunchSurface('claude', chatHost)).toBeUndefined()
    expect(mobileStructuredChatLaunchSurface('gemini', chatHost)).toBeUndefined()
    expect(
      mobileStructuredChatLaunchSurface('antigravity', {
        ...chatHost,
        defaultView: 'terminal'
      })
    ).toBeUndefined()
    expect(
      mobileStructuredChatLaunchSurface('antigravity', {
        ...chatHost,
        canRequestSurface: false
      })
    ).toBeUndefined()
    expect(mobileStructuredChatLaunchSurface('antigravity', null)).toBeUndefined()
  })

  it('marks a new tab that opens in chat and leaves a terminal unmarked', () => {
    const rows = [
      { agent: 'claude', label: 'Claude' },
      { agent: 'codex', label: 'Codex' },
      { agent: 'grok', label: 'Grok' },
      { agent: 'antigravity', label: 'Antigravity' },
      { agent: 'gemini', label: 'Gemini' },
      { agent: 'hermes', label: 'Hermes' }
    ]
    const hinted = (context: MobileStructuredChatLaunchContext | null) =>
      withMobileStructuredChatLaunch(rows, context).flatMap((row) =>
        row.opensAsChat ? [row.agent] : []
      )

    expect(hinted(chatHost)).toEqual(['claude', 'codex', 'grok', 'antigravity'])
    expect(mobileNewTabHostLaunchSurface('claude', chatHost)).toBeUndefined()
    expect(mobileNewTabHostLaunchSurface('codex', chatHost)).toBeUndefined()
    expect(mobileNewTabHostLaunchSurface('grok', chatHost)).toBeUndefined()
    expect(mobileNewTabHostLaunchSurface('antigravity', chatHost)).toBe('chat')
    expect(mobileNewTabHostLaunchSurface('gemini', chatHost)).toBeUndefined()
    expect(mobileNewTabHostLaunchSurface('hermes', chatHost)).toBe('terminal')

    const terminalDefault: MobileStructuredChatLaunchContext = {
      ...chatHost,
      defaultView: 'terminal'
    }
    expect(hinted(terminalDefault)).toEqual([])
    expect(mobileNewTabHostLaunchSurface('antigravity', terminalDefault)).toBeUndefined()
    expect(mobileNewTabHostLaunchSurface('claude', terminalDefault)).toBeUndefined()

    const hermesChat: MobileStructuredChatLaunchContext = {
      ...chatHost,
      registeredAgents: ['hermes', 'antigravity', 'claude'],
      hostCapabilities: [
        AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
        HERMES_TRANSCRIPT_RUNTIME_CAPABILITY
      ]
    }
    expect(hinted(hermesChat)).toEqual(['claude', 'codex', 'grok', 'antigravity', 'hermes'])
    expect(mobileNewTabHostLaunchSurface('hermes', hermesChat)).toBe('terminal')

    const unproven: MobileStructuredChatLaunchContext = {
      ...chatHost,
      registeredAgents: [],
      canRequestSurface: false,
      hostCapabilities: []
    }
    expect(hinted(unproven)).toEqual(['claude', 'codex', 'grok'])
    expect(mobileNewTabHostLaunchSurface('antigravity', unproven)).toBeUndefined()
    expect(mobileNewTabHostLaunchSurface('claude', null)).toBeUndefined()
    expect(hinted(null)).toEqual([])
  })
})

describe('loadMobileStructuredChatLaunchContext', () => {
  beforeEach(() => {
    vi.mocked(AsyncStorage.getItem).mockReset()
    vi.mocked(AsyncStorage.getItem).mockResolvedValue(null)
  })

  it('does not publish an older host response after a newer load', async () => {
    let finishOlder: (response: RpcResponse) => void = () => {}
    const olderResponse = new Promise<RpcResponse>((resolve) => {
      finishOlder = resolve
    })
    const capabilities = [STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY]
    const older = loadMobileStructuredChatLaunchContext({
      client: client(() => olderResponse),
      hostCapabilities: capabilities
    })
    const newer = await loadMobileStructuredChatLaunchContext({
      client: client(async () => ok({ agents: [registered('antigravity')] })),
      hostCapabilities: capabilities
    })
    finishOlder(ok({ agents: [registered('hermes')] }))
    await older
    expect(readMobileStructuredChatLaunchContext()).toEqual(newer)
  })

  it('reads Chat UI and the host registry when the host can launch a surface', async () => {
    vi.mocked(AsyncStorage.getItem).mockResolvedValue('chat')
    const sendRequest = vi.fn(async (method: string) => {
      expect(method).toBe(AGENT_SESSION_AGENTS_METHOD)
      return ok({ agents: [registered('antigravity'), registered('claude')] })
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
      canRequestSurface: false,
      hostCapabilities: ['agent.launch.v2']
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
    expect(mobileStructuredChatLaunchSurface('antigravity', context)).toBeUndefined()
  })

  it('reads a fresh status when the gate capability list is still empty', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return ok({
          capabilities: [
            AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
            STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
          ]
        })
      }
      expect(method).toBe(AGENT_SESSION_AGENTS_METHOD)
      return ok({ agents: [registered('antigravity'), registered('claude')] })
    })
    const context = await loadMobileStructuredChatLaunchContext({
      client: client(sendRequest),
      hostCapabilities: []
    })
    expect(context.canRequestSurface).toBe(true)
    expect(context.registeredAgents).toEqual(['antigravity', 'claude'])
    expect(
      mobileStructuredChatLaunchSurface('antigravity', {
        ...context,
        defaultView: 'chat'
      })
    ).toBe('chat')
    expect(mobileStructuredChatLaunchSurface('claude', context)).toBeUndefined()
  })

  it('uses the page store for Chat UI and marks Antigravity only once Chat UI is on', async () => {
    vi.mocked(AsyncStorage.getItem).mockImplementation((key: string) =>
      pageAsyncStorage.getItem(key)
    )
    publishPageStorage({}, () => true, 'host-1', '/h/host-1/session/wt-1')
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'status.get') {
        return ok({
          capabilities: [
            AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY,
            STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY
          ]
        })
      }
      return ok({ agents: [registered('antigravity')] })
    })
    const unread = await loadMobileStructuredChatLaunchContext({
      client: client(sendRequest),
      hostCapabilities: null
    })
    expect(unread.defaultView).toBe('terminal')
    expect(
      withMobileStructuredChatLaunch([{ agent: 'antigravity', label: 'Antigravity' }], unread)
    ).toEqual([{ agent: 'antigravity', label: 'Antigravity' }])

    publishPageStorage(
      {},
      () => true,
      'host-1',
      '/h/host-1/session/wt-1',
      [],
      null,
      async (key) => (key === 'orca:defaultSessionView' ? 'chat' : null)
    )
    const fromShell = await loadMobileStructuredChatLaunchContext({
      client: client(sendRequest),
      hostCapabilities: null
    })
    expect(fromShell.defaultView).toBe('chat')
    expect(mobileStructuredChatLaunchSurface('antigravity', fromShell)).toBe('chat')

    publishPageStorage({}, () => true, 'host-1', '/h/host-1/session/wt-1')
    refreshPageTerminalShortcuts({ 'orca:defaultSessionView': 'chat' }, [])
    const refreshed = await loadMobileStructuredChatLaunchContext({
      client: client(sendRequest),
      hostCapabilities: null
    })
    expect(refreshed.defaultView).toBe('chat')
    expect(mobileStructuredChatLaunchSurface('antigravity', refreshed)).toBe('chat')
  })
})
