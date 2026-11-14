import { describe, expect, it, vi } from 'vitest'
import { executePluginHostCall } from './plugin-host-methods'
import type { PluginHostServices } from './plugin-host-method-bindings'
import type { PluginCapabilityKind } from '../../../../shared/plugins/capabilities/plugin-capabilities'

function services(runtimeRpc: PluginHostServices['runtimeRpc']): PluginHostServices {
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

const call = (
  method: string,
  params: unknown,
  rpc: PluginHostServices['runtimeRpc'],
  granted: PluginCapabilityKind[] = ['workspace:write']
) =>
  executePluginHostCall({
    pluginId: 'samples.demo',
    method,
    params,
    surface: 'worker',
    grantedCapabilities: granted,
    services: services(rpc),
    audit: { record: vi.fn().mockResolvedValue(undefined) }
  })

describe('workspace.rename', () => {
  it('reports a conflict when Orca keeps the old name, as during a WSL move', async () => {
    const rpc = vi.fn().mockResolvedValue({ worktree: { displayName: 'old' } })
    expect(await call('workspace.rename', { workspaceId: 'id-1', name: 'new' }, rpc)).toMatchObject(
      { ok: false, code: 'conflict' }
    )
  })

  it('refuses blank, multi-line, bidi or invisible names and plugins without workspace:write', async () => {
    const rpc = vi.fn()
    const outcomes = await Promise.all(
      [
        '   ',
        'a\nb',
        'x'.repeat(201),
        'main\u202egnp',
        'a\u200bb',
        'a\u0085b',
        '\u3164',
        'a\ufe0fb'
      ].map((name) => call('workspace.rename', { workspaceId: 'id-1', name }, rpc))
    )
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ ok: false, code: 'invalid_params' })
    }
    expect(
      await call('workspace.rename', { workspaceId: 'id-1', name: 'ok' }, rpc, ['workspace:read'])
    ).toMatchObject({ ok: false })
    expect(rpc).not.toHaveBeenCalled()
  })
})
