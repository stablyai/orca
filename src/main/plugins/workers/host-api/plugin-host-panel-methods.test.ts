import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { executePluginHostCall } from './plugin-host-methods'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import type { PluginPanelBridgeServices } from './plugin-host-panel-method-bindings'
import type { PluginCapabilityKind } from '../../../../shared/plugins/capabilities/plugin-capabilities'

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
    requestBytes: vi.fn(async (..._args: unknown[]) => new ArrayBuffer(4)),
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

describe('plugin.requestBytes', () => {
  it('answers a frame of the desktop window and refuses a client that came over RPC', async () => {
    const panels = bridge()
    const ask = (callerWebContentsId?: number) =>
      executePluginHostCall({
        pluginId: 'acme.todos',
        method: 'plugin.requestBytes',
        params: { name: 'signal.read' },
        surface: 'panel',
        grantedCapabilities: [],
        services: services(panels),
        scope: { assertActive: () => undefined, panel, callerWebContentsId }
      })
    await expect(ask()).resolves.toMatchObject({ ok: false, code: 'not_permitted' })
    // The refusal comes before the worker does any work.
    expect(panels.requestBytes).not.toHaveBeenCalled()
    const answer = await ask(7)
    expect(answer).toMatchObject({ ok: true, value: { bytes: expect.any(ArrayBuffer) } })
  })
})
