import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../../transport/rpc/rpc-wire-types'
import { scopeRpcClientToExecutionHost } from '../../worktree/execution-hosts/execution-host-scoped-rpc-client'
import { FLOATING_WORKSPACE_WORKTREE_ID } from '../floating-workspace'
import { loadMobileAgentLaunchContext, newTabAgentOptionsFrom } from './mobile-new-tab-agent-loader'

// The paired desktop answers settings.get; settings.getAgentLaunch reaches the tagged server.
function desktopRelayingTo(server: { getAgentLaunch: RpcResponse }): RpcClient {
  const reply = (method: string, host: unknown): RpcResponse => {
    if (method === 'settings.get') {
      return { id: method, ok: true, result: { settings: { defaultTuiAgent: 'claude' } } }
    }
    if (method === 'preflight.detectAgents') {
      return { id: method, ok: true, result: ['claude', 'codex', 'gemini'] }
    }
    if (method === 'settings.getAgentLaunch' && host === 'runtime:server-1') {
      return server.getAgentLaunch
    }
    throw new Error(`unexpected ${method}`)
  }
  return {
    sendRequest: async (method, _params, options) =>
      reply(method, options?.envelope?.executionHost),
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

async function agentsListed(server: { getAgentLaunch: RpcResponse }) {
  const client = scopeRpcClientToExecutionHost(desktopRelayingTo(server), 'runtime:server-1')
  const { settings, detectedAgents } = await loadMobileAgentLaunchContext({
    client,
    worktreeId: FLOATING_WORKSPACE_WORKTREE_ID
  })
  return newTabAgentOptionsFrom(settings, detectedAgents).map((option) => option.agent)
}

describe('new tab agents in a server workspace the desktop relays', () => {
  it("orders and hides agents by the server's preferences", async () => {
    const agents = await agentsListed({
      getAgentLaunch: {
        id: 'settings.getAgentLaunch',
        ok: true,
        result: { settings: { defaultTuiAgent: 'codex', disabledTuiAgents: ['gemini'] } }
      }
    })
    expect(agents).toEqual(['codex', 'claude'])
  })
})
