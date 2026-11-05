import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import { resolveTerminalPalette } from '../../../shared/terminal-themes/terminal-theme-selection'

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
  it('publishes owned app/editor/terminal colors and restores them on host startup without changing plugin code', async () => {
    const h = await harness()
    const result = await h.service.executeHostCall(
      'local.appearance',
      'appearance.apply',
      colors(await revision(h.service)),
      'worker'
    )
    expect(result).toMatchObject({
      ok: true,
      value: {
        themeId: 'plugin:local.appearance/runtime-dark',
        mode: 'dark',
        delivery: 'published'
      }
    })
    expect(h.settings()).toMatchObject({
      theme: 'dark',
      pluginAppThemeDark: 'plugin:local.appearance/runtime-dark',
      editorThemeDark: 'plugin:local.appearance/runtime-dark',
      terminalThemeDark: 'plugin:local.appearance/runtime-dark',
      terminalPluginPalettes: [
        {
          id: 'plugin:local.appearance/runtime-dark',
          colors: { background: '#101218', foreground: '#eeeeee', red: '#ff7777' }
        }
      ],
      terminalFontSize: 19,
      terminalBackgroundOpacity: 0.73
    })
    expect(h.service.contentPacks.themes.list()).toMatchObject([
      { id: 'plugin:local.appearance/runtime-dark', tokens: { '--background': '#101218' } }
    ])
    expect(resolveTerminalPalette(h.settings(), true).theme?.red).toBe('#ff7777')
    expect(await readFile(join(h.root, 'worker.mjs'), 'utf8')).toBe(
      'export default function () {}\n'
    )
    await h.service.dispose()
    const restarted = h.create()
    await restarted.initialize()
    expect(restarted.contentPacks.themes.list()).toMatchObject([
      { id: 'plugin:local.appearance/runtime-dark', tokens: { '--background': '#101218' } }
    ])
  })

  it('retains the other mode and saved terminal palette when switching light/dark', async () => {
    const h = await harness()
    await h.service.executeHostCall(
      'local.appearance',
      'appearance.apply',
      colors(await revision(h.service)),
      'worker'
    )
    await h.service.executeHostCall(
      'local.appearance',
      'appearance.apply',
      colors(await revision(h.service), 'light'),
      'worker'
    )
    expect(h.settings()).toMatchObject({
      theme: 'light',
      pluginAppThemeDark: 'plugin:local.appearance/runtime-dark',
      pluginAppThemeLight: 'plugin:local.appearance/runtime-light',
      terminalThemeDark: 'plugin:local.appearance/runtime-dark',
      terminalThemeLight: 'plugin:local.appearance/runtime-light',
      terminalPluginPalettes: [
        { id: 'plugin:local.appearance/runtime-dark', colors: { red: '#ff7777' } },
        { id: 'plugin:local.appearance/runtime-light', colors: { red: '#ff7777' } }
      ]
    })
  })

  it('rejects stale revisions after a user change and after a competing publication', async () => {
    const h = await harness()
    const stale = await revision(h.service)
    h.manualTheme()
    expect(
      await h.service.executeHostCall(
        'local.appearance',
        'appearance.apply',
        colors(stale),
        'worker'
      )
    ).toMatchObject({ ok: false, code: 'conflict' })
    const fresh = await revision(h.service)
    await h.service.executeHostCall('local.appearance', 'appearance.apply', colors(fresh), 'worker')
    expect(
      await h.service.executeHostCall(
        'local.appearance',
        'appearance.apply',
        colors(fresh, 'light'),
        'worker'
      )
    ).toMatchObject({ ok: false, code: 'conflict' })
    expect(h.settings().theme).toBe('dark')
  })

  it('preserves the last good publication when validation fails', async () => {
    const h = await harness()
    await h.service.executeHostCall(
      'local.appearance',
      'appearance.apply',
      colors(await revision(h.service)),
      'worker'
    )
    const input = colors(await revision(h.service))
    input.app = '{invalid'
    expect(
      await h.service.executeHostCall('local.appearance', 'appearance.apply', input, 'worker')
    ).toMatchObject({ ok: false, code: 'invalid_params' })
    expect(h.service.contentPacks.themes.list()).toMatchObject([
      { tokens: { '--background': '#101218' } }
    ])
    expect(await revision(h.service)).toBe(input.expectedRevision)
  })

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

  it('requires appearance approval and a worker surface rather than plugin-private settings access', async () => {
    const h = await harness({ capability: false })
    expect(
      await h.service.executeHostCall(
        'local.appearance',
        'appearance.apply',
        colors('0'.repeat(64)),
        'worker'
      )
    ).toMatchObject({ ok: false, code: 'capability_denied' })
    const approved = await harness()
    expect(
      await approved.service.executeHostCall(
        'local.appearance',
        'appearance.apply',
        colors(await revision(approved.service)),
        'panel'
      )
    ).toMatchObject({ ok: false, code: 'not_permitted' })
    expect(approved.settings().pluginAppThemeDark).toBeNull()
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

  it('does not publish an appearance after its worker cancels the call', async () => {
    const h = await harness()
    const input = colors(await revision(h.service))
    const controller = new AbortController()
    controller.abort()
    expect(
      await h.service.executeHostCall('local.appearance', 'appearance.apply', input, 'worker', {
        signal: controller.signal
      })
    ).toMatchObject({ ok: false, code: 'cancelled' })
    expect(h.settings().pluginAppThemeDark).toBeNull()
  })

  it('fails explicitly where no desktop appearance service exists', async () => {
    const h = await harness({ desktop: false })
    expect(
      await h.service.executeHostCall('local.appearance', 'appearance.read', {}, 'worker')
    ).toMatchObject({ ok: false, code: 'unavailable' })
    expect(h.settings().pluginAppThemeDark).toBeNull()
  })

  it('revokes a publication disabled while admission awaits its audit write', async () => {
    const h = await harness()
    const input = colors(await revision(h.service))
    const pending = h.service.executeHostCall(
      'local.appearance',
      'appearance.apply',
      input,
      'worker'
    )
    h.disable()
    expect(await pending).toMatchObject({ ok: false, code: 'consent_required' })
    expect(h.settings().pluginAppThemeDark).toBeNull()
    expect(h.service.contentPacks.themes.list()).toEqual([])
  })
})
