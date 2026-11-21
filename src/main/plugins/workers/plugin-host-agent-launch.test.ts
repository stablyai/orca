import { describe, expect, it, vi } from 'vitest'
import { executePluginHostCall, type PluginHostServices } from './plugin-host-methods'
import type { PluginRuntimeRpc } from './plugin-host-workspace-method-bindings'

function services(runtimeRpc: PluginRuntimeRpc): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    listAgentStatuses: () => [],
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      keys: vi.fn().mockReturnValue([])
    },
    secrets: {
      get: vi.fn().mockReturnValue({ ok: true, value: null }),
      set: vi.fn().mockReturnValue({ ok: true }),
      delete: vi.fn(),
      protection: vi.fn().mockReturnValue('unavailable')
    },
    settings: {
      getAll: vi.fn().mockReturnValue({}),
      set: vi.fn().mockReturnValue({ ok: true })
    },
    runtimeRpc
  }
}

function launch(runtimeRpc: PluginRuntimeRpc, params: { prompt?: string }) {
  return executePluginHostCall({
    pluginId: 'acme.launch',
    method: 'agent.launch',
    params: { workspaceId: 'ws_1', agent: 'claude', ...params },
    surface: 'worker',
    grantedCapabilities: ['agent:launch'],
    services: services(runtimeRpc),
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    scope: { assertActive: () => undefined }
  })
}

describe('plugin host agent.launch', () => {
  it('sends the prompt on the launch that starts the agent', async () => {
    const calls: unknown[] = []
    const runtimeRpc: PluginRuntimeRpc = async (method, params) => {
      calls.push({ method, params })
      return { outcome: { kind: 'terminal', handle: 'term_1' } }
    }

    await expect(launch(runtimeRpc, { prompt: 'hello' })).resolves.toEqual({
      ok: true,
      value: { terminalId: 'term_1' }
    })
    expect(calls).toEqual([
      {
        method: 'agent.launch',
        params: {
          target: { kind: 'existing', worktree: 'id:ws_1' },
          agent: 'claude',
          surface: 'terminal',
          presentation: 'background',
          launchSource: 'plugin',
          prompt: { text: 'hello', delivery: 'submit' }
        }
      }
    ])
  })

  it('starts without a prompt when the caller omits one', async () => {
    const calls: unknown[] = []
    const runtimeRpc: PluginRuntimeRpc = async (method, params) => {
      calls.push({ method, params })
      return { outcome: { kind: 'terminal', handle: 'term_1' } }
    }

    await expect(launch(runtimeRpc, {})).resolves.toEqual({
      ok: true,
      value: { terminalId: 'term_1' }
    })
    expect(calls).toEqual([
      {
        method: 'agent.launch',
        params: {
          target: { kind: 'existing', worktree: 'id:ws_1' },
          agent: 'claude',
          surface: 'terminal',
          presentation: 'background',
          launchSource: 'plugin'
        }
      }
    ])
  })
})
