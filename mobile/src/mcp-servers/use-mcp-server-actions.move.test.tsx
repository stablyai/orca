// The phone's Move asks first: Cancel sends nothing; Move sends only the agents the confirm named,
// and an older host's row (no removesFrom) sends none, so that host decides. Synthetic data only.
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { translate } from '../i18n/mobile-i18n'
import type { PhoneDiscoveredMcpServer } from './mcp-server-operations'
import { useMcpServerActions } from './use-mcp-server-actions'

const sent: { method: string; params: unknown }[] = []
const client: RpcClient = {
  sendRequest: async (method: string, params?: unknown): Promise<RpcResponse> => {
    sent.push({ method, params })
    return { id: '1', ok: false, error: { code: 'synthetic', message: 'synthetic' } }
  },
  subscribe: () => () => {},
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => null,
  getLastInboundAt: () => null,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}

let renderer: ReactTestRenderer | undefined
let actions: ReturnType<typeof useMcpServerActions>
function Harness() {
  actions = useMcpServerActions({
    client,
    list: null,
    applyServer: () => {},
    showToast: () => {},
    t: translate
  })
  return null
}

const entry = (removesFrom?: string[]): PhoneDiscoveredMcpServer => ({
  key: 'alpha-key',
  name: 'alpha',
  detail: 'https://alpha.example.test/mcp',
  transport: 'http',
  agents: ['codex', 'cursor'],
  ...(removesFrom ? { removesFrom } : {}),
  files: [],
  projectNames: [],
  movable: true
})

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  sent.length = 0
})

describe('phone Move confirmation', () => {
  it('Cancel sends nothing; Move sends only the confirmed agents', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    act(() => actions.move(entry(['codex'])))
    expect(actions.confirm?.message).toBe(
      "Orca uses a new or existing entry on this host's MCP server list. It tries to remove eligible copies from the settings for Codex. Before removing entries from a settings file, Orca backs up that file."
    )
    act(() => actions.closeConfirm())
    await settle()
    expect(actions.confirm).toBeNull()
    expect(sent).toEqual([])

    act(() => actions.move(entry(['codex'])))
    act(() => actions.confirm!.onConfirm())
    await settle()
    expect(sent.filter((request) => request.method === 'mcpServers.move')).toEqual([
      { method: 'mcpServers.move', params: { key: 'alpha-key', agents: ['codex'] } }
    ])
  })

  it('an older host’s row sends no agents and names every agent it lists', async () => {
    act(() => {
      renderer = create(createElement(Harness))
    })
    act(() => actions.move(entry()))
    expect(actions.confirm?.message).toContain('the settings for Codex and Cursor.')
    act(() => actions.confirm!.onConfirm())
    await settle()
    expect(sent.filter((request) => request.method === 'mcpServers.move')).toEqual([
      { method: 'mcpServers.move', params: { key: 'alpha-key' } }
    ])
  })
})
