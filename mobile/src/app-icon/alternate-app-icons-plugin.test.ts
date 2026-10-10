import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { APP_ICON_OPTIONS, DEFAULT_APP_ICON_ID } from '../../../src/shared/app-icon'
import {
  alternateIconName,
  setAndroidLauncherAliases,
  setIosAlternateIconNames,
  writeAndroidIconResources,
  writeIosIconSets
} from '../../plugins/alternate-app-icons'
import { alternateIconNameFor } from './app-icon-switcher'

vi.mock('./native-app-icon', () => ({ nativeAppIcon: null }))

const mobileRoot = resolve(import.meta.dirname, '../..')
const pluginPath = './plugins/alternate-app-icons.js'
const blueSource = './assets/app-icons/orca-blue.png'

function configuredIcons(): Record<string, string> {
  const appJson = JSON.parse(readFileSync(join(mobileRoot, 'app.json'), 'utf8'))
  const entry = appJson.expo.plugins.find(
    (plugin: unknown) => Array.isArray(plugin) && plugin[0] === pluginPath
  )
  return entry[1].icons
}

let tempDir: string | undefined
function makeTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'orca-app-icons-'))
  return tempDir
}

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('configured alternate icons', () => {
  it('bundles every shared icon option except the primary one', () => {
    const expected = APP_ICON_OPTIONS.map(({ id }) => id).filter((id) => id !== DEFAULT_APP_ICON_ID)
    expect(Object.keys(configuredIcons()).sort()).toEqual([...expected].sort())
  })

  it('uses ids that are valid Android resource and class name parts', () => {
    for (const iconId of Object.keys(configuredIcons())) {
      expect(iconId).toMatch(/^[a-z][a-z0-9]*$/)
    }
  })

  it('ships opaque 1024px PNGs, which both platforms need for a full-bleed icon', () => {
    for (const source of Object.values(configuredIcons())) {
      const png = readFileSync(join(mobileRoot, source))
      expect({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }).toEqual({
        width: 1024,
        height: 1024
      })
      // IHDR colour type 2 is RGB; 6 would carry alpha that iOS renders as black.
      expect(png[25]).toBe(2)
    }
  })

  it('names icons exactly as the runtime asks for them', () => {
    for (const { id } of APP_ICON_OPTIONS.filter(({ id }) => id !== DEFAULT_APP_ICON_ID)) {
      expect(alternateIconNameFor(id)).toBe(alternateIconName(id))
    }
  })
})

describe('iOS prebuild output', () => {
  it('writes a single-size app icon set per icon', () => {
    const catalog = makeTempDir()
    writeIosIconSets(catalog, mobileRoot, { blue: blueSource })
    const iconSetDir = join(catalog, 'AppIconBlue.appiconset')
    expect(JSON.parse(readFileSync(join(iconSetDir, 'Contents.json'), 'utf8')).images).toEqual([
      { filename: 'icon.png', idiom: 'universal', platform: 'ios', size: '1024x1024' }
    ])
    expect(readFileSync(join(iconSetDir, 'icon.png'))).toEqual(
      readFileSync(join(mobileRoot, blueSource))
    )
  })

  it('lists the icon sets on target build configurations only', () => {
    const targetDebug = { buildSettings: { PRODUCT_NAME: 'Orca' } }
    const projectDebug = { buildSettings: { SDKROOT: 'iphoneos' } }
    const section = { targetDebug, targetDebug_comment: 'Debug', projectDebug }
    setIosAlternateIconNames(
      { pbxXCBuildConfigurationSection: () => section },
      { watercolor: 'a.png', blue: 'b.png' }
    )
    expect(targetDebug.buildSettings).toHaveProperty(
      'ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES',
      '"AppIconWatercolor AppIconBlue"'
    )
    expect(projectDebug.buildSettings).not.toHaveProperty(
      'ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES'
    )
  })
})

type ManifestElement = { $: Record<string, string> }
type IntentFilter = {
  action?: ManifestElement[]
  category?: ManifestElement[]
  data?: ManifestElement[]
}
type ExpoManifest = {
  manifest: {
    $: Record<string, string>
    application: (ManifestElement & {
      activity: (ManifestElement & { 'intent-filter': IntentFilter[] })[]
      'activity-alias'?: ManifestElement[]
    })[]
  }
}

describe('Android prebuild output', () => {
  function expoManifest(): ExpoManifest {
    const launcher = {
      action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
      category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }]
    }
    const deepLink = {
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      data: [{ $: { 'android:scheme': 'orca' } }]
    }
    return {
      manifest: {
        $: {},
        application: [
          {
            $: {
              'android:name': '.MainApplication',
              'android:icon': '@mipmap/ic_launcher',
              'android:roundIcon': '@mipmap/ic_launcher_round'
            },
            activity: [
              { $: { 'android:name': '.MainActivity' }, 'intent-filter': [launcher, deepLink] }
            ]
          }
        ]
      }
    }
  }

  function aliasSummary(manifest: ExpoManifest) {
    return (manifest.manifest.application[0]['activity-alias'] ?? []).map(({ $ }) => ({
      name: $['android:name'],
      enabled: $['android:enabled'],
      icon: $['android:icon'],
      target: $['android:targetActivity']
    }))
  }

  it('moves the launcher entry from MainActivity onto one alias per icon', () => {
    const manifest = expoManifest()
    setAndroidLauncherAliases(manifest, { blue: blueSource })
    const mainActivity = manifest.manifest.application[0].activity[0]
    // Deep links stay on MainActivity; only the launcher filter moves.
    expect(mainActivity['intent-filter']).toHaveLength(1)
    expect(mainActivity['intent-filter'][0].action?.[0].$['android:name']).toBe(
      'android.intent.action.VIEW'
    )
    expect(aliasSummary(manifest)).toEqual([
      { name: '.AppIcon', enabled: 'true', icon: '@mipmap/ic_launcher', target: '.MainActivity' },
      {
        name: '.AppIconBlue',
        enabled: 'false',
        icon: '@mipmap/app_icon_blue',
        target: '.MainActivity'
      }
    ])
  })

  it('does not duplicate aliases when prebuild runs over an existing android folder', () => {
    const manifest = expoManifest()
    setAndroidLauncherAliases(manifest, { blue: blueSource })
    setAndroidLauncherAliases(manifest, { blue: blueSource })
    expect(aliasSummary(manifest).map(({ name }) => name)).toEqual(['.AppIcon', '.AppIconBlue'])
  })

  it('writes an adaptive icon plus a pre-API-26 fallback for each icon', () => {
    const resDir = makeTempDir()
    writeAndroidIconResources(resDir, mobileRoot, { blue: blueSource })
    expect(readFileSync(join(resDir, 'drawable-nodpi', 'app_icon_blue.png'))).toEqual(
      readFileSync(join(mobileRoot, blueSource))
    )
    expect(readFileSync(join(resDir, 'mipmap-anydpi-v26', 'app_icon_blue.xml'), 'utf8')).toContain(
      '<inset android:drawable="@drawable/app_icon_blue" android:inset="16.7%"/>'
    )
    expect(readFileSync(join(resDir, 'mipmap-anydpi', 'app_icon_blue.xml'), 'utf8')).toContain(
      'android:src="@drawable/app_icon_blue"'
    )
  })
})
