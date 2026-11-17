import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginWorkerHandle } from '../workers/parent-process/plugin-host-process-types'
import { PluginPanelBridge } from './plugin-panel-bridge'

const caller = { id: 'panel-a', surface: 'panel' as const, contributionId: 'todos' }

function setup(
  options: { main?: string; capabilities?: PluginCapabilityKind[]; approved?: boolean } = {}
) {
  const worker = {
    requestFromPanel: vi.fn(async (_request?: { signal?: AbortSignal }): Promise<unknown> => ({
      ok: true
    })),
    notifyDataChanged: vi.fn()
  }
  const plugin = { pluginKey: 'acme.todos', manifest: { main: options.main ?? 'main.mjs' } }
  const log = vi.fn()
  const bridge = new PluginPanelBridge({
    findApprovedPlugin: (key) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge reads only pluginKey and manifest.main.
      key === plugin.pluginKey ? (plugin as never as ValidDiscoveredPlugin) : null,
    grantedCapabilities: () => (options.approved === false ? null : (options.capabilities ?? [])),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge calls only requestFromPanel and notifyDataChanged.
    ensureWorker: async () => worker as never as PluginWorkerHandle,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above.
    runningWorker: () => worker as never as PluginWorkerHandle,
    log: () => log,
    now: () => 0
  })
  return { bridge, worker, log }
}

const request = (name = 'todos.list', input: unknown = { done: false }) => ({
  pluginKey: 'acme.todos',
  caller,
  name,
  input
})

describe('PluginPanelBridge requests', () => {
  it('refuses answers over 1 MiB or that are not JSON', async () => {
    const { bridge, worker } = setup()
    worker.requestFromPanel.mockResolvedValueOnce({ big: 'x'.repeat(1024 * 1024 + 1) })
    await expect(bridge.request(request())).rejects.toMatchObject({ code: 'too_large' })
    worker.requestFromPanel.mockResolvedValueOnce({ when: new Date(0) })
    await expect(bridge.request(request())).rejects.toMatchObject({ code: 'action_failed' })
    worker.requestFromPanel.mockResolvedValueOnce(undefined)
    await expect(bridge.request(request())).resolves.toBeNull()
  })
})

describe('PluginPanelBridge pushes', () => {
  it('sends events only to panels that subscribed and hold the read capability', () => {
    const denied = setup()
    expect(() => denied.bridge.subscribe('acme.todos', caller.id, 'agent.status.changed')).toThrow(
      expect.objectContaining({ code: 'capability_denied' })
    )
    const { bridge } = setup({ capabilities: ['agent:read'] })
    const subscribed = vi.fn()
    const quiet = vi.fn()
    bridge.open(caller, 'acme.todos', subscribed)
    bridge.open({ ...caller, id: 'panel-b' }, 'acme.todos', quiet)
    bridge.subscribe('acme.todos', caller.id, 'agent.status.changed')
    const payload = { workspaceId: null, paneKey: 'p', state: 'done', receivedAt: 1 }
    expect(bridge.publishEvent('agent.status.changed', payload)).toBe(1)
    expect(bridge.publishEvent('agent.status.changed', { malformed: true })).toBe(0)
    // `dev emit` limits it to one plugin's panels.
    expect(bridge.publishEvent('agent.status.changed', payload, { pluginKey: 'acme.other' })).toBe(
      0
    )
    expect(subscribed).toHaveBeenCalledOnce()
    expect(subscribed).toHaveBeenCalledWith({
      kind: 'event',
      event: 'agent.status.changed',
      payload
    })
    expect(quiet).not.toHaveBeenCalled()
  })
})
