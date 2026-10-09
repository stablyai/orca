import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import type { AgentSessionOptionsResult } from '../../../src/shared/agent-session-wire'
import type { AgentChatPermissionMode } from '../../../src/shared/agent-chat-permission-mode'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredAgentOptions } from './use-mobile-structured-agent-options'

type Controller = ReturnType<typeof useMobileStructuredAgentOptions>
type Refresh = {
  permissionMode: string | null
  turnId: string | null
  connected: boolean
  providerPhase: string
  unloadedTurnRevisions: number
}

it('refreshes idle host permission changes, turn and provider changes, and reconnects without reading on ordinary renders', async () => {
  let mode: AgentChatPermissionMode = 'ask'
  const reads = vi.fn(async (): Promise<AgentSessionOptionsResult> => ({
    models: [{ id: 'm', label: 'M', isDefault: true, efforts: [] }],
    current: { model: 'm' },
    permissionModes: { current: mode, supported: ['ask', 'auto', 'bypass'] }
  }))
  const client: RpcClient = {
    // Only the options read is counted; the host's model list never answers here.
    sendRequest: async (method) =>
      method === 'agentSession.modelCatalog'
        ? new Promise(() => {})
        : { id: 'r', ok: true, result: await reads(), _meta: { runtimeId: 'h' } },
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  let current: Controller | null = null
  const mutate = vi.fn()
  function Probe(refresh: Refresh) {
    current = useMobileStructuredAgentOptions({
      agent: 'codex',
      client,
      sessionId: 's',
      enabled: true,
      fence: 1,
      mutate,
      ...refresh
    })
    return null
  }
  let renderer: ReactTestRenderer | null = null
  let refresh: Refresh = {
    permissionMode: 'ask',
    turnId: null,
    connected: true,
    providerPhase: 'ready',
    unloadedTurnRevisions: 0
  }
  const render = async (next: Partial<Refresh> = {}) => {
    refresh = { ...refresh, ...next }
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Probe, refresh))
      } else {
        renderer = create(createElement(Probe, refresh))
      }
    })
  }
  const picker = () => {
    if (!current) {
      throw new Error('hook did not render')
    }
    return current.permissionPicker
  }
  try {
    await render()
    expect(picker()?.current).toBe('ask')
    expect(reads).toHaveBeenCalledTimes(1)
    mode = 'bypass'
    await render({ permissionMode: 'bypass' })
    expect(picker()?.current).toBe('bypass')
    expect(reads).toHaveBeenCalledTimes(2)
    await render()
    expect(reads).toHaveBeenCalledTimes(2)
    await render({ turnId: 't' })
    await render({ turnId: null })
    await render({ providerPhase: 'starting' })
    await render({ providerPhase: 'ready' })
    await render({ unloadedTurnRevisions: 1 })
    expect(reads).toHaveBeenCalledTimes(7)
    await render({ connected: false })
    expect(reads).toHaveBeenCalledTimes(7)
    mode = 'ask'
    await render({ connected: true })
    expect(picker()?.current).toBe('ask')
    expect(reads).toHaveBeenCalledTimes(8)
  } finally {
    await act(async () => renderer?.unmount())
  }
})
