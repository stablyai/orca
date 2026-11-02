import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { PLUGIN_SCHEMA_NEWEST_SINCE } from '../../shared/plugins/installation/plugin-host-version'
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

  // Regression: Excalidraw 1.0.0 as installed from the catalog before the format 2 floor moved.
  it('loads an installed manifest whose engines floor predates its fields, but not a dev copy', async () => {
    const pluginsDir = await tempPluginsDir()
    const devDir = await tempPluginsDir()
    const hash = 'c'.repeat(64)
    const versionDir = join(pluginsDir, 'stablyai.orca-excalidraw', hash)
    const manifest = JSON.stringify({
      manifestVersion: 2,
      id: 'orca-excalidraw',
      publisher: 'stablyai',
      name: 'Excalidraw',
      version: '1.0.0',
      execution: 'sandboxed-ui',
      engines: { orca: '>=1.4.244' },
      contributes: {
        customEditors: [
          {
            id: 'excalidraw',
            title: 'Excalidraw',
            extensions: ['.excalidraw', '.excalidraw.json'],
            entry: 'editor/index.html',
            priority: 'default'
          }
        ]
      },
      capabilities: []
    })
    for (const dir of [versionDir, devDir]) {
      await mkdir(join(dir, 'editor'), { recursive: true })
      await writeFile(join(dir, 'orca-plugin.json'), manifest)
      await writeFile(join(dir, 'editor', 'index.html'), '<p>editor</p>')
    }
    await writeFile(join(pluginsDir, 'stablyai.orca-excalidraw', 'current'), hash)

    const [installed] = await discoverPlugins({
      pluginsDir,
      devPluginPaths: [],
      hostVersion: '1.4.245'
    })
    expect(installed && 'error' in installed ? installed.error : null).toBeNull()
    expect(installed?.pluginKey).toBe('stablyai.orca-excalidraw')

    const [dev] = await discoverPlugins({
      pluginsDir: await tempPluginsDir(),
      devPluginPaths: [devDir],
      hostVersion: '1.4.245'
    })
    expect(dev && 'error' in dev ? dev.error : '').toContain('engines.orca: must be at least')

    // An older host still names the version gap rather than a schema error.
    const [old] = await discoverPlugins({ pluginsDir, devPluginPaths: [], hostVersion: '1.4.200' })
    expect(old && 'error' in old ? old.error : '').toBe('requires Orca >=1.4.244 (this is 1.4.200)')
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
