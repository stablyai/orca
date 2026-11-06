import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { fingerprintPluginConsent } from '../../../shared/plugins/approval/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../../shared/plugins/manifest/plugin-manifest'
import { PLUGIN_HOST_API } from '../../../shared/plugins/workers/plugin-host-api'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { devFolderConsentIdentity } from '../plugin-discovery'
import { PluginService } from '../plugin-service'
import { createPluginAppearanceService } from './plugin-appearance-service'

const services: PluginService[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function harness(options: { capability?: boolean; desktop?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'orca-appearance-'))
  roots.push(root)
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 2,
    execution: 'trusted-worker',
    id: 'appearance',
    name: 'Appearance',
    version: '1.0.0',
    engines: { orca: '>=1.4.249' },
    main: 'worker.mjs',
    capabilities: options.capability === false ? [] : [{ kind: 'appearance:write' }]
  })
  await writeFile(join(root, 'orca-plugin.json'), JSON.stringify(manifest))
  await writeFile(join(root, 'worker.mjs'), 'export default function () {}\n')
  const consent = fingerprintPluginConsent(manifest, await devFolderConsentIdentity(root))
  let disabled = false
  let settings = getDefaultSettings(root)
  let failSettings = false
  settings.terminalFontSize = 19
  settings.terminalBackgroundOpacity = 0.73
  settings.terminalColorOverrides = { red: '#0000ff' }
  function create() {
    let service: PluginService | null = null
    const appearance = createPluginAppearanceService(
      {
        getSettings: () => settings,
        updateSettings: (updates) => {
          if (failSettings) {
            throw new Error('settings store unavailable')
          }
          settings = { ...settings, ...updates }
        }
      },
      root,
      () => service
    )
    service = new PluginService({
      userDataPath: root,
      hostVersion: '1.4.249',
      isPluginSystemEnabled: () => true,
      getDisabledPlugins: () => (disabled ? ['local.appearance'] : []),
      getPluginConsents: () => ({ 'local.appearance': consent }),
      getDevPluginPaths: () => [root],
      ...(options.desktop === false
        ? {}
        : {
            appearance
          })
    })
    service.setRuntimeDelegate({
      resolveActiveWorktreeContext: async () => null,
      listTerminals: async () => ({ terminals: [] }),
      sendTerminal: async () => ({ accepted: false }),
      dispatchPluginNotification: async () => ({ delivered: false })
    })
    services.push(service)
    return service
  }
  const service = create()
  await service.initialize()
  return {
    root,
    service,
    create,
    settings: () => settings,
    manualTheme: (theme: GlobalSettings['theme'] = 'light') => {
      settings = { ...settings, theme }
      service.options.appearance?.settingsChanged({ theme })
    },
    disable: () => {
      disabled = true
    },
    failSettings: () => {
      failSettings = true
    }
  }
}

async function revision(service: PluginService): Promise<string> {
  const result = await service.executeHostCall('local.appearance', 'appearance.read', {}, 'worker')
  if (!result.ok) {
    throw new Error(result.error)
  }
  return PLUGIN_HOST_API['appearance.read'].result.parse(result.value).revision
}

function colors(expectedRevision: string, mode: 'dark' | 'light' = 'dark') {
  return {
    expectedRevision,
    app: JSON.stringify({
      base: mode,
      tokens: { '--background': '#101218', '--foreground': '#eeeeee' }
    }),
    terminal: JSON.stringify({
      schemaVersion: 1,
      mode,
      terminal: { background: '#101218', foreground: '#eeeeee', red: '#ff7777' }
    })
  }
}

describe('plugin desktop appearance publication', () => {
  it('rejects a stale call even when a user changes away and back to the original theme', async () => {
    const h = await harness()
    const stale = await revision(h.service)
    h.manualTheme('light')
    h.manualTheme('system')
    expect(
      await h.service.executeHostCall(
        'local.appearance',
        'appearance.apply',
        colors(stale),
        'worker'
      )
    ).toMatchObject({ ok: false, code: 'conflict' })
    expect(h.settings().pluginAppThemeDark).toBeNull()
  })

  it('restores the persisted prior appearance if committing settings fails', async () => {
    const h = await harness()
    await h.service.executeHostCall(
      'local.appearance',
      'appearance.apply',
      colors(await revision(h.service)),
      'worker'
    )
    h.failSettings()
    expect(
      await h.service.executeHostCall(
        'local.appearance',
        'appearance.apply',
        colors(await revision(h.service), 'light'),
        'worker'
      )
    ).toMatchObject({ ok: false, code: 'action_failed', error: 'settings store unavailable' })
    expect(h.settings().theme).toBe('dark')
    await h.service.dispose()
    const restarted = h.create()
    await restarted.initialize()
    expect(restarted.contentPacks.themes.list()).toMatchObject([
      { id: 'plugin:local.appearance/runtime-dark' }
    ])
  })
})
