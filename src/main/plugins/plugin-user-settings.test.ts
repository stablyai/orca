import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePluginManifest } from '../../shared/plugins/plugin-manifest'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { readPluginUserSettings, writePluginUserSetting } from './plugin-user-settings'

const PLUGIN_KEY = 'orca-samples.roadmap'
let dataDir = ''

function plugin(): ValidDiscoveredPlugin {
  const parsed = parsePluginManifest({
    manifestVersion: 1,
    id: 'roadmap',
    publisher: 'orca-samples',
    name: 'Roadmap',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    contributes: {
      settings: [
        {
          key: 'sort',
          title: 'Sort by',
          type: 'enum',
          default: 'updated',
          options: [
            { value: 'updated', label: 'Updated' },
            { value: 'priority', label: 'Priority' }
          ]
        },
        { key: 'listName', title: 'List name', type: 'string' }
      ]
    },
    capabilities: [{ kind: 'settings:own' }]
  })
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return {
    pluginKey: PLUGIN_KEY,
    rootDir: '/plugin',
    manifest: parsed.manifest,
    consentFingerprint: 'sha256-current',
    contentHash: null,
    isDev: true
  }
}

function deps() {
  const subject = plugin()
  return {
    findValidPlugin: (pluginKey: string) => (pluginKey === PLUGIN_KEY ? subject : null),
    pluginsDataDir: dataDir
  }
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'orca-plugin-user-settings-'))
})

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

describe('plugin user settings', () => {
  it('stores declared values where the worker reads them and resets with null', async () => {
    expect(readPluginUserSettings(deps(), { pluginKey: PLUGIN_KEY })).toEqual({})

    expect(
      writePluginUserSetting(deps(), { pluginKey: PLUGIN_KEY, key: 'sort', value: 'priority' })
    ).toEqual({ sort: 'priority' })
    writePluginUserSetting(deps(), { pluginKey: PLUGIN_KEY, key: 'listName', value: 'Backlog' })
    const stored = JSON.parse(await readFile(join(dataDir, PLUGIN_KEY, 'settings.json'), 'utf8'))
    expect(stored).toEqual({ sort: 'priority', listName: 'Backlog' })

    expect(
      writePluginUserSetting(deps(), { pluginKey: PLUGIN_KEY, key: 'sort', value: null })
    ).toEqual({ listName: 'Backlog' })
  })

  it('refuses undeclared keys, wrong types, and unknown plugins', () => {
    expect(() =>
      writePluginUserSetting(deps(), { pluginKey: PLUGIN_KEY, key: 'secret', value: 'x' })
    ).toThrow('does not declare setting secret')
    expect(() =>
      writePluginUserSetting(deps(), { pluginKey: PLUGIN_KEY, key: 'sort', value: 'cloud' })
    ).toThrow('invalid value for setting sort')
    expect(() => readPluginUserSettings(deps(), { pluginKey: 'orca-samples.other' })).toThrow(
      'not installed'
    )
  })
})
