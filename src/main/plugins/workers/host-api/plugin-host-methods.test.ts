import { describe, expect, it, vi } from 'vitest'
import { executePluginHostCall } from './plugin-host-methods'
import type { PluginHostServices } from './plugin-host-method-bindings'

function createServices(storageSet: PluginHostServices['storage']['set']): PluginHostServices {
  return {
    resolveActiveWorktreeContext: vi.fn().mockResolvedValue(null),
    listWorktreeTerminals: vi.fn().mockResolvedValue([]),
    sendTerminalText: vi.fn().mockResolvedValue({ accepted: true }),
    listAgentStatuses: () => [],
    dispatchPluginNotification: vi.fn().mockResolvedValue({ delivered: true }),
    storage: {
      get: vi.fn(),
      set: storageSet,
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
    }
  }
}

describe('executePluginHostCall mutation auditing', () => {
  it('fails closed before a mutation when the audit intent cannot be recorded', async () => {
    const storageSet = vi.fn().mockReturnValue({ ok: true })
    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'storage.set',
      params: { key: 'answer', value: 42 },
      surface: 'worker',
      grantedCapabilities: ['storage:own'],
      services: createServices(storageSet),
      audit: { record: vi.fn().mockRejectedValue(new Error('disk full')) }
    })

    expect(outcome).toMatchObject({ ok: false, code: 'action_failed' })
    expect(storageSet).not.toHaveBeenCalled()
  })
})

describe('workspace.readContext host reachability', () => {
  it('keeps the active remote context when its host cannot list terminals', async () => {
    const services = createServices(vi.fn())
    vi.mocked(services.resolveActiveWorktreeContext).mockResolvedValue({
      worktreeId: 'remote-repo::/home/user/repo',
      branch: '',
      displayName: 'Remote main'
    })
    vi.mocked(services.listWorktreeTerminals).mockRejectedValue(new Error('host_unreachable'))

    const outcome = await executePluginHostCall({
      pluginId: 'samples.demo',
      method: 'workspace.readContext',
      params: {},
      surface: 'panel',
      grantedCapabilities: ['workspace:read'],
      services
    })

    expect(outcome).toMatchObject({
      ok: true,
      value: { branch: '', displayName: 'Remote main', terminals: [] }
    })
  })
})

describe('workspace.readContext workspace id', () => {
  it('is the id workspace.list gives: identity form, folder key, else the raw id', async () => {
    const contexts = [
      { worktreeId: 'repo::/w', identityKey: 'wt2:local:i1' },
      { worktreeId: 'folder:f1' },
      // A remote workspace known only from stored rows has no identity.
      { worktreeId: 'remote-repo::/home/user/repo' }
    ]
    const outcomes = await Promise.all(
      contexts.map((context) => {
        const services = createServices(vi.fn())
        vi.mocked(services.resolveActiveWorktreeContext).mockResolvedValue({
          ...context,
          branch: '',
          displayName: 'w'
        })
        return executePluginHostCall({
          pluginId: 'samples.demo',
          method: 'workspace.readContext',
          params: {},
          surface: 'worker',
          grantedCapabilities: ['workspace:read'],
          services
        })
      })
    )
    expect(outcomes).toMatchObject([
      { ok: true, value: { workspaceId: 'identity:wt2:local:i1' } },
      { ok: true, value: { workspaceId: 'folder:f1' } },
      { ok: true, value: { workspaceId: 'remote-repo::/home/user/repo' } }
    ])
  })
})

describe('workspace.readContext in frames', () => {
  it('gives panels only path-free ids', async () => {
    const read = (worktreeId: string) => {
      const services = createServices(vi.fn())
      vi.mocked(services.resolveActiveWorktreeContext).mockResolvedValue({
        worktreeId,
        branch: '',
        displayName: 'w'
      })
      return executePluginHostCall({
        pluginId: 'samples.demo',
        method: 'workspace.readContext',
        params: {},
        surface: 'panel',
        grantedCapabilities: ['workspace:read'],
        services
      })
    }
    const [raw, folder] = await Promise.all([read('repo::/home/me/w'), read('folder:f1')])
    expect(raw.ok && raw.value).not.toHaveProperty('workspaceId')
    expect(folder).toMatchObject({ ok: true, value: { workspaceId: 'folder:f1' } })
  })
})
