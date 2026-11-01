import { describe, expect, it, vi } from 'vitest'
import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'
import type { ValidDiscoveredPlugin } from '../plugin-discovery'
import type { PluginWorkerHandle } from '../workers/plugin-host-process'
import { PluginPanelBridge } from './plugin-panel-bridge'

const caller = { id: 'panel-a', surface: 'panel' as const, contributionId: 'todos' }

function setup(options: { main?: string; capabilities?: PluginCapabilityKind[] } = {}) {
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
    grantedCapabilities: () => options.capabilities ?? [],
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
  it("asks the plugin's own worker, with the panel, a deadline and the panel's lifetime", async () => {
    const { bridge, worker } = setup()
    await expect(bridge.request(request())).resolves.toEqual({ ok: true })
    expect(worker.requestFromPanel).toHaveBeenCalledWith({
      name: 'todos.list',
      input: { done: false },
      panel: caller,
      timeoutMs: 30_000,
      signal: expect.any(AbortSignal)
    })
  })

  it('aborts in-flight requests when the panel session closes', async () => {
    const { bridge, worker } = setup()
    let signal: AbortSignal | undefined
    worker.requestFromPanel.mockImplementation(async (sent?: { signal?: AbortSignal }) => {
      signal = sent?.signal
      return { ok: true }
    })
    await bridge.request(request())
    bridge.close(caller.id)
    expect(signal?.aborted).toBe(true)
  })

  it('keeps worker error codes, and refuses plugins without a worker', async () => {
    const { bridge, worker } = setup()
    worker.requestFromPanel.mockRejectedValueOnce(
      Object.assign(new Error('no'), { code: 'unknown_method' })
    )
    await expect(bridge.request(request())).rejects.toMatchObject({ code: 'unknown_method' })
    await expect(setup({ main: '' }).bridge.request(request())).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

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
  it('delivers worker posts to every open panel of that plugin, or the one named', () => {
    const { bridge } = setup()
    const a = vi.fn()
    const b = vi.fn()
    const other = vi.fn()
    bridge.open(caller, 'acme.todos', a)
    bridge.open({ ...caller, id: 'panel-b' }, 'acme.todos', b)
    bridge.open({ ...caller, id: 'panel-c' }, 'acme.other', other)
    bridge.onWorkerPost('acme.todos', { event: 'todos.changed', payload: { count: 1 } })
    bridge.onWorkerPost('acme.todos', { event: 'todos.changed', payload: 2, panel: 'panel-b' })
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenLastCalledWith({ kind: 'message', event: 'todos.changed', payload: 2 })
    expect(other).not.toHaveBeenCalled()
  })

  it('drops posts past the size or rate budget, and says so in the log', () => {
    const { bridge, log } = setup()
    const deliver = vi.fn()
    bridge.open(caller, 'acme.todos', deliver)
    bridge.onWorkerPost('acme.todos', { event: 'big', payload: 'x'.repeat(300 * 1024) })
    for (let index = 0; index < 205; index += 1) {
      bridge.onWorkerPost('acme.todos', { event: 'tick', payload: index })
    }
    expect(deliver).toHaveBeenCalledTimes(199)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('256 KiB'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('too many posts'))
  })

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

  it('keeps a subscription made before the renderer opens the channel', () => {
    const { bridge } = setup({ capabilities: ['workspace:read'] })
    bridge.subscribe('acme.todos', caller.id, 'workspace.changed')
    expect(bridge.hasSubscribers('workspace.changed')).toBe(false)
    const deliver = vi.fn()
    bridge.open(caller, 'acme.todos', deliver)
    expect(bridge.hasSubscribers('workspace.changed')).toBe(true)
    bridge.publishEvent('workspace.changed', { context: null })
    expect(deliver).toHaveBeenCalledWith({
      kind: 'event',
      event: 'workspace.changed',
      payload: { context: null }
    })
  })

  it('tells open panels and the running worker which key changed', () => {
    const { bridge, worker } = setup()
    const deliver = vi.fn()
    bridge.open(caller, 'acme.todos', deliver)
    bridge.dataChanged('acme.todos', 'storage', 'todos')
    expect(deliver).toHaveBeenCalledWith({ kind: 'changed', area: 'storage', key: 'todos' })
    expect(worker.notifyDataChanged).toHaveBeenCalledWith({ area: 'storage', key: 'todos' })
  })

  it('stops delivering once its channel is closed or the session ends', () => {
    const { bridge } = setup()
    const deliver = vi.fn()
    const stop = bridge.open(caller, 'acme.todos', deliver)
    stop()
    bridge.onWorkerPost('acme.todos', { event: 'x', payload: 1 })
    bridge.open(caller, 'acme.todos', deliver)
    bridge.close(caller.id)
    bridge.onWorkerPost('acme.todos', { event: 'x', payload: 1 })
    expect(deliver).not.toHaveBeenCalled()
  })
})
