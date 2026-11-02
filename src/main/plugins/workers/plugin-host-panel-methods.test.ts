import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { executePluginHostCall } from './plugin-host-methods'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import type { PluginPanelBridgeServices } from './plugin-host-panel-method-bindings'
import type { PluginCapabilityKind } from '../../../shared/plugins/capabilities/plugin-capabilities'

const panel = { id: 'panel-1', surface: 'panel' as const, contributionId: 'todos' }

function services(panels: PluginPanelBridgeServices | null = null) {
  return bindPluginHostServices({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods never reach the runtime delegate.
    delegate: {} as PluginRuntimeDelegate,
    pluginsDataDir: mkdtempSync(join(tmpdir(), 'orca-panel-methods-')),
    panels,
    declaredSettings: [
      { key: 'pageSize', title: 'Page size', type: 'integer', default: 20, minimum: 1 }
    ]
  })
}

function bridge() {
  return {
    request: vi.fn(async (..._args: unknown[]) => ['todo']),
    subscribe: vi.fn(),
    dataChanged: vi.fn()
  } satisfies PluginPanelBridgeServices
}

const call = (
  method: string,
  params: unknown,
  options: {
    surface?: 'panel' | 'worker'
    panels?: PluginPanelBridgeServices
    grants?: PluginCapabilityKind[]
    withPanel?: boolean
  }
) => {
  const bound = services(options.panels ?? null)
  return executePluginHostCall({
    pluginId: 'acme.todos',
    method,
    params,
    surface: options.surface ?? 'panel',
    grantedCapabilities: options.grants ?? ['settings:own', 'storage:own'],
    services: bound,
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    scope: { assertActive: () => undefined, panel: options.withPanel === false ? undefined : panel }
  })
}

describe('plugin.request', () => {
  it("routes to the plugin's own worker with the calling panel", async () => {
    const panels = bridge()
    await expect(
      call(
        'plugin.request',
        { name: 'todos.list', input: { done: true }, timeoutMs: 500 },
        { panels }
      )
    ).resolves.toEqual({ ok: true, value: { output: ['todo'] } })
    expect(panels.request).toHaveBeenCalledWith(
      'acme.todos',
      { name: 'todos.list', input: { done: true }, timeoutMs: 500 },
      panel
    )
  })

  it('is for open frames only', async () => {
    await expect(
      call('plugin.request', { name: 'x' }, { surface: 'worker', panels: bridge() })
    ).resolves.toMatchObject({
      code: 'not_permitted'
    })
    await expect(
      call('plugin.request', { name: 'x' }, { panels: bridge(), withPanel: false })
    ).resolves.toMatchObject({
      code: 'not_permitted'
    })
    await expect(
      call('plugin.request', { name: 'has space' }, { panels: bridge() })
    ).resolves.toMatchObject({
      code: 'invalid_params'
    })
  })
})

describe('panel storage and settings', () => {
  it('reads declared settings with their default and refuses values of the wrong type', async () => {
    const panels = bridge()
    await expect(call('settings.get', {}, { panels })).resolves.toEqual({
      ok: true,
      value: { settings: { pageSize: 20 } }
    })
    await expect(
      call('settings.set', { key: 'pageSize', value: 0 }, { panels })
    ).resolves.toMatchObject({
      ok: false,
      error: 'pageSize must be at least 1'
    })
    expect(panels.dataChanged).not.toHaveBeenCalled()
  })

  it('tells panels and the worker after a write lands', async () => {
    const panels = bridge()
    await expect(
      call('storage.set', { key: 'todos', value: [1] }, { panels })
    ).resolves.toMatchObject({ ok: true })
    expect(panels.dataChanged).toHaveBeenCalledWith('acme.todos', 'storage', 'todos')
  })

  it('keeps the capability gate for panels', async () => {
    await expect(call('storage.get', { key: 'todos' }, { grants: [] })).resolves.toMatchObject({
      code: 'capability_denied'
    })
  })
})
