import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { Store } from '../persistence'
import { applyPluginConsent, applyPluginEnablement } from './plugin-enablement'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import type { PluginService } from './plugin-service'

const pluginKey = 'orca-samples.demo'
const manifest = pluginManifestSchema.parse({
  manifestVersion: 1,
  id: 'demo',
  publisher: 'orca-samples',
  name: 'Demo',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: {},
  capabilities: []
})

function createStore(): {
  store: Store
  getSettings: () => GlobalSettings
  updateSettings: ReturnType<typeof vi.fn>
} {
  let settings = getDefaultSettings(tmpdir())
  const updateSettings = vi.fn((updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
  })
  return {
    store: { getSettings: () => settings, updateSettings } as unknown as Store,
    getSettings: () => settings,
    updateSettings
  }
}

function createPluginService(
  getFingerprint: () => string,
  overrides: Partial<ValidDiscoveredPlugin> = {}
): PluginService {
  return {
    findValidPlugin: (requestedKey: string) =>
      requestedKey === pluginKey
        ? {
            pluginKey,
            rootDir: tmpdir(),
            manifest,
            consentFingerprint: getFingerprint(),
            consentContentHash: null,
            contentHash: null,
            isDev: true,
            ...overrides
          }
        : null,
    reconcileActivationState: vi.fn().mockResolvedValue(undefined)
  } as unknown as PluginService
}

describe('applyPluginConsent', () => {
  it('stores approval only for the fingerprint the user reviewed', async () => {
    const harness = createStore()
    const pluginService = createPluginService(() => 'sha256-reviewed')

    await applyPluginConsent({
      store: harness.store,
      pluginService,
      pluginKey,
      reviewedFingerprint: 'sha256-reviewed',
      decision: 'approve'
    })

    expect(harness.getSettings().pluginConsents[pluginKey]).toBe('sha256-reviewed')
    expect(harness.getSettings().disabledPlugins).not.toContain(pluginKey)
  })

  it('rejects a stale review after a same-key plugin update without writing settings', async () => {
    const harness = createStore()
    let currentFingerprint = 'sha256-reviewed-v1'
    const pluginService = createPluginService(() => currentFingerprint)
    currentFingerprint = 'sha256-current-v2'

    await expect(
      applyPluginConsent({
        store: harness.store,
        pluginService,
        pluginKey,
        reviewedFingerprint: 'sha256-reviewed-v1',
        decision: 'approve'
      })
    ).rejects.toThrow('changed since its permissions were reviewed')

    expect(harness.updateSettings).not.toHaveBeenCalled()
    expect(harness.getSettings().pluginConsents[pluginKey]).toBeUndefined()
  })

  it('allows a stale dialog to keep the newer plugin disabled', async () => {
    const harness = createStore()
    const pluginService = createPluginService(() => 'sha256-current-v2')

    await applyPluginConsent({
      store: harness.store,
      pluginService,
      pluginKey,
      reviewedFingerprint: 'sha256-reviewed-v1',
      decision: 'keep-disabled'
    })

    expect(harness.getSettings().disabledPlugins).toContain(pluginKey)
    expect(pluginService.reconcileActivationState).toHaveBeenCalledOnce()
  })
})

describe('applyPluginEnablement', () => {
  it('does not persist unknown plugin identities', async () => {
    const harness = createStore()
    const pluginService = createPluginService(() => 'sha256-current')

    await expect(
      applyPluginEnablement({
        store: harness.store,
        pluginService,
        pluginKey: 'orca-samples.unknown',
        enabled: false
      })
    ).rejects.toThrow('unknown plugin')

    expect(harness.updateSettings).not.toHaveBeenCalled()
  })
})
