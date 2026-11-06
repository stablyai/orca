import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { executePluginHostCall } from './plugin-host-methods'
import { bindPluginHostServices, type PluginRuntimeDelegate } from './plugin-host-service-bindings'
import { PluginStatusBarState } from '../status-bar/plugin-status-bar-state'

function call(
  params: unknown,
  options: { state?: PluginStatusBarState | null; surface?: 'worker' | 'panel' } = {}
) {
  return executePluginHostCall({
    pluginId: 'acme.guard',
    method: 'statusBar.update',
    params,
    surface: options.surface ?? 'worker',
    grantedCapabilities: [],
    services: bindPluginHostServices({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: statusBar.update never reaches the runtime delegate.
      delegate: {} as PluginRuntimeDelegate,
      pluginsDataDir: mkdtempSync(join(tmpdir(), 'orca-status-bar-methods-')),
      statusBar: options.state === undefined ? new PluginStatusBarState() : options.state,
      declaredStatusBarItemIds: ['blocked']
    }),
    audit: { record: vi.fn().mockResolvedValue(undefined) },
    scope: { assertActive: () => undefined }
  })
}

describe('statusBar.update', () => {
  it("layers a worker's changes over its declared item and tells listeners", async () => {
    const state = new PluginStatusBarState()
    const listener = vi.fn()
    state.onChanged(listener)
    await expect(
      call({ id: 'blocked', text: '1 blocked', tone: 'warning' }, { state })
    ).resolves.toEqual({ ok: true, value: { ok: true } })
    await call({ id: 'blocked', tooltip: 'Blocked commands' }, { state })
    expect(state.snapshot()).toEqual({
      'acme.guard': {
        blocked: { text: '1 blocked', tone: 'warning', tooltip: 'Blocked commands' }
      }
    })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('refuses an undeclared item, a panel caller and a host without a status bar', async () => {
    await expect(call({ id: 'other', text: 'x' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_params'
    })
    await expect(call({ id: 'blocked', text: 'x' }, { surface: 'panel' })).resolves.toMatchObject({
      ok: false,
      code: 'not_permitted'
    })
    await expect(call({ id: 'blocked', text: 'x' }, { state: null })).resolves.toMatchObject({
      ok: false,
      code: 'unavailable'
    })
    await expect(call({ id: 'blocked', command: 'x' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid_params'
    })
  })
})
