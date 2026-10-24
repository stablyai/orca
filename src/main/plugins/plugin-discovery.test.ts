import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { PLUGIN_SCHEMA_NEWEST_SINCE } from '../../shared/plugins/plugin-host-version'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverPlugins, isInvalidDiscoveredPlugin } from './plugin-discovery'
import { PLUGIN_CURRENT_POINTER_MAX_BYTES } from './installation/plugin-current-pointer'
import { getPluginActivationState } from '../../shared/plugins/approval/plugin-consent-state'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempPluginsDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-discovery-'))
  roots.push(root)
  return root
}

describe('project repositories', () => {
  it('can neither load nor approve a plugin they carry', async () => {
    const userPlugins = await tempPluginsDir()
    const worktree = await tempPluginsDir()
    const manifest = JSON.stringify({
      manifestVersion: 2,
      execution: 'sandboxed-ui',
      id: 'repo-panel',
      publisher: 'acme',
      name: 'Repo panel',
      version: '1.0.0',
      engines: { orca: `>=${PLUGIN_SCHEMA_NEWEST_SINCE}` },
      contributes: { panels: [{ id: 'p', title: 'P', entry: 'p.html' }] }
    })
    // Every place a repository might plausibly drop a plugin for Orca to pick up.
    for (const dir of [worktree, join(worktree, '.orca', 'plugins', 'acme.repo-panel')]) {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'orca-plugin.json'), manifest)
      await writeFile(join(dir, 'p.html'), '<p>repo</p>')
    }
    const discover = (devPluginPaths: string[]) =>
      discoverPlugins({
        pluginsDir: userPlugins,
        devPluginPaths,
        hostVersion: PLUGIN_SCHEMA_NEWEST_SINCE
      })

    // Why: roots are the user's plugins dir and dev folders the user added, never a workspace.
    expect(await discover([])).toEqual([])
    // Even after the user adds the repo as a dev folder, it waits for approval: consent lives
    // only in user settings, keyed by the reviewed fingerprint.
    const [plugin] = await discover([worktree])
    if (!plugin || isInvalidDiscoveredPlugin(plugin)) {
      throw new Error('expected a valid dev plugin')
    }
    expect(
      getPluginActivationState(plugin.pluginKey, plugin.consentFingerprint, {
        pluginConsents: {},
        disabledPlugins: []
      })
    ).toBe('pending')
  })
})

describe('installed plugin discovery identity', () => {
  it('requires a new review when an installed v2 worker has different bytes', async () => {
    const pluginsDir = await tempPluginsDir()
    const key = 'samples.worker'
    const discoverAt = async (hash: string) => {
      const versionDir = join(pluginsDir, key, hash)
      await mkdir(versionDir, { recursive: true })
      await writeFile(join(pluginsDir, key, 'current'), hash)
      await writeFile(join(versionDir, 'main.mjs'), 'export default () => {}')
      await writeFile(
        join(versionDir, 'orca-plugin.json'),
        JSON.stringify({
          manifestVersion: 2,
          execution: 'trusted-worker',
          id: 'worker',
          publisher: 'samples',
          name: 'Worker',
          version: '1.0.0',
          engines: { orca: `>=${PLUGIN_SCHEMA_NEWEST_SINCE}` },
          pluginApi: 1,
          main: 'main.mjs'
        })
      )
      const [plugin] = await discoverPlugins({
        pluginsDir,
        devPluginPaths: [],
        hostVersion: PLUGIN_SCHEMA_NEWEST_SINCE
      })
      if (!plugin || isInvalidDiscoveredPlugin(plugin)) {
        throw new Error('expected a valid plugin')
      }
      return plugin
    }

    const approved = await discoverAt('a'.repeat(64))
    const updated = await discoverAt('b'.repeat(64))

    expect(updated.consentContentHash).toBe('b'.repeat(64))
    expect(updated.consentFingerprint).not.toBe(approved.consentFingerprint)
  })

  it('keeps the install directory identity when a manifest is invalid or mismatched', async () => {
    const pluginsDir = await tempPluginsDir()
    const installedKey = 'samples.expected'
    const hash = 'a'.repeat(64)
    const versionDir = join(pluginsDir, installedKey, hash)
    await mkdir(versionDir, { recursive: true })
    await writeFile(join(pluginsDir, installedKey, 'current'), hash)
    await writeFile(
      join(versionDir, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'different',
        publisher: 'samples',
        name: 'Different',
        version: '1.0.0',
        engines: { orca: '>=1.0.0' },
        pluginApi: 1,
        contributes: { panels: [], commands: [], events: [] },
        capabilities: []
      })
    )

    const [plugin] = await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.0' })

    expect(plugin && isInvalidDiscoveredPlugin(plugin)).toBe(true)
    expect(plugin?.pluginKey).toBe(installedKey)
    expect(plugin && 'error' in plugin ? plugin.error : '').toContain('does not match')
  })

  it('names the version gap when a plugin for a newer Orca uses fields this build lacks', async () => {
    const pluginsDir = await tempPluginsDir()
    const hash = 'b'.repeat(64)
    const versionDir = join(pluginsDir, 'acme.future', hash)
    await mkdir(versionDir, { recursive: true })
    await writeFile(join(pluginsDir, 'acme.future', 'current'), hash)
    await writeFile(
      join(versionDir, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 2,
        execution: 'data',
        id: 'future',
        publisher: 'acme',
        name: 'Future',
        version: '1.0.0',
        engines: { orca: '>=9.0.0' },
        pluginApi: 1,
        contributes: { widgets: [{ id: 'clock' }] }
      })
    )

    const [plugin] = await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.0' })

    expect(plugin && 'error' in plugin ? plugin.error : '').toBe(
      'requires Orca >=9.0.0 (this is 1.4.0)'
    )
  })

  it('keeps a removable qualified identity when the current pointer is missing', async () => {
    const pluginsDir = await tempPluginsDir()
    const installedKey = 'samples.broken'
    await mkdir(join(pluginsDir, installedKey), { recursive: true })

    const [plugin] = await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.0' })

    expect(plugin && isInvalidDiscoveredPlugin(plugin)).toBe(true)
    expect(plugin?.pluginKey).toBe(installedKey)
  })

  it('rejects an oversized current pointer without an unbounded startup read', async () => {
    const pluginsDir = await tempPluginsDir()
    const installedKey = 'samples.broken'
    const pluginDir = join(pluginsDir, installedKey)
    await mkdir(pluginDir, { recursive: true })
    const pointer = join(pluginDir, 'current')
    await writeFile(pointer, '')
    await truncate(pointer, PLUGIN_CURRENT_POINTER_MAX_BYTES + 1)

    const [plugin] = await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.0' })

    expect(plugin && isInvalidDiscoveredPlugin(plugin)).toBe(true)
    expect(plugin?.pluginKey).toBe(installedKey)
  })
})

describe('declarative plugin discovery identity', () => {
  it('changes dev consent when a VM recipe command changes', async () => {
    const pluginsDir = await tempPluginsDir()
    const devRoot = await tempPluginsDir()
    await mkdir(join(devRoot, 'recipes'))
    await writeFile(
      join(devRoot, 'orca-plugin.json'),
      JSON.stringify({
        manifestVersion: 1,
        id: 'recipes',
        publisher: 'samples',
        name: 'Recipes',
        version: '1.0.0',
        engines: { orca: '>=1.0.0' },
        pluginApi: 1,
        contributes: { vmRecipes: [{ path: 'recipes/cloud.json' }] },
        capabilities: []
      })
    )
    const recipePath = join(devRoot, 'recipes', 'cloud.json')
    await writeFile(
      recipePath,
      JSON.stringify({ schemaVersion: 1, id: 'cloud', name: 'Cloud', create: 'create-v1' })
    )
    const [first] = await discoverPlugins({
      pluginsDir,
      devPluginPaths: [devRoot],
      hostVersion: '1.4.0'
    })
    await writeFile(
      recipePath,
      JSON.stringify({ schemaVersion: 1, id: 'cloud', name: 'Cloud', create: 'create-v2' })
    )
    const [second] = await discoverPlugins({
      pluginsDir,
      devPluginPaths: [devRoot],
      hostVersion: '1.4.0'
    })

    expect(first && !isInvalidDiscoveredPlugin(first)).toBe(true)
    expect(second && !isInvalidDiscoveredPlugin(second)).toBe(true)
    if (
      !first ||
      !second ||
      isInvalidDiscoveredPlugin(first) ||
      isInvalidDiscoveredPlugin(second)
    ) {
      return
    }
    expect(second.consentContentHash).not.toBe(first.consentContentHash)
    expect(second.consentFingerprint).not.toBe(first.consentFingerprint)
  })
})
