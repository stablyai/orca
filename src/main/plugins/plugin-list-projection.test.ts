import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyPluginLockfile } from '../../shared/plugins/plugin-install-lockfile'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { InvalidDiscoveredPlugin, ValidDiscoveredPlugin } from './plugin-discovery'
import { buildPluginList } from './plugin-list-projection'
import type { PluginService } from './plugin-service'

const manifest = pluginManifestSchema.parse({
  manifestVersion: 1,
  id: 'demo',
  publisher: 'orca-samples',
  name: 'Demo',
  version: '1.0.0',
  engines: { orca: '>=1.0.0' },
  pluginApi: 1,
  contributes: { panels: [], commands: [], events: [] },
  capabilities: [{ kind: 'workspace:read' }]
})

function serviceWith(
  discovered: ValidDiscoveredPlugin,
  options: {
    activation?: ReturnType<PluginService['activationState']>
    worker?: ReturnType<PluginService['workerState']>
    vmRecipes?: ReturnType<PluginService['contentPacks']['vmRecipes']['preview']>
    commands?: ReturnType<PluginService['contentPacks']['commands']['preview']>
  } = {}
): PluginService {
  return {
    options: {
      getPluginConsents: () => ({}),
      getDisabledPlugins: () => []
    },
    getDiscovered: () => [discovered],
    activationState: () => options.activation ?? 'pending',
    workerState: () => options.worker ?? { state: 'inactive', restarts: 0 },
    activationError: () => null,
    contentPacks: {
      vmRecipes: { preview: () => options.vmRecipes ?? [] },
      commands: { preview: () => options.commands ?? [] }
    }
  } as unknown as PluginService
}

describe('buildPluginList consent identity', () => {
  it('projects the exact current fingerprint for an optimistic consent write', async () => {
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }

    expect((await buildPluginList(serviceWith(plugin), emptyPluginLockfile()))[0]).toMatchObject({
      pluginKey: plugin.pluginKey,
      consentFingerprint: 'sha256-current',
      status: 'pending'
    })
  })

  it('projects supervised backoff as restarting instead of running', async () => {
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }

    expect(
      (
        await buildPluginList(
          serviceWith(plugin, {
            activation: 'approved',
            worker: { state: 'restarting', restarts: 2 }
          }),
          emptyPluginLockfile()
        )
      )[0]
    ).toMatchObject({ status: 'restarting', restarts: 2 })
  })

  it('does not attribute a shadowing dev plugin to the installed source', async () => {
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'development', 'demo'),
      manifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }
    const lock = {
      version: 1 as const,
      plugins: {
        [plugin.pluginKey]: {
          pluginKey: plugin.pluginKey,
          version: '1.0.0',
          source: { kind: 'git' as const, url: 'https://example.com/demo.git', ref: 'v1' },
          resolvedCommit: 'a'.repeat(40),
          contentHash: 'b'.repeat(64),
          consentFingerprint: 'sha256-installed',
          installedAt: 1
        }
      }
    }

    expect((await buildPluginList(serviceWith(plugin), lock))[0]).not.toHaveProperty('source')
  })

  it('does not expose an invalid development plugin absolute path as identity', async () => {
    const invalid: InvalidDiscoveredPlugin = {
      rootDir: join(tmpdir(), 'private', 'secret-plugin-path'),
      error: 'missing orca-plugin.json',
      isDev: true
    }
    const service = {
      options: { getPluginConsents: () => ({}), getDisabledPlugins: () => [] },
      getDiscovered: () => [invalid]
    } as unknown as PluginService

    const projected = (await buildPluginList(service, emptyPluginLockfile()))[0]!
    expect(projected.pluginKey).toBe('invalid-development-plugin-1')
    expect(projected.name).toBe('invalid-development-plugin-1')
    expect(JSON.stringify(projected)).not.toContain(invalid.rootDir)
  })

  it('projects exact VM lifecycle commands for instructional consent', async () => {
    const recipeManifest = pluginManifestSchema.parse({
      ...manifest,
      contributes: { vmRecipes: [{ path: 'recipes/cloud.json' }] }
    })
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest: recipeManifest,
      consentFingerprint: 'sha256-current',
      consentContentHash: 'a'.repeat(64),
      contentHash: null,
      isDev: true
    }

    expect(
      (
        await buildPluginList(
          serviceWith(plugin, {
            vmRecipes: [
              {
                pluginKey: plugin.pluginKey,
                recipe: {
                  id: 'cloud',
                  name: 'Cloud',
                  create: './create.sh',
                  destroyDisabled: true
                }
              }
            ]
          }),
          emptyPluginLockfile()
        )
      )[0]?.vmRecipes
    ).toEqual([
      {
        id: 'cloud',
        name: 'Cloud',
        commands: [
          { phase: 'create', command: './create.sh' },
          { phase: 'destroy', command: 'none' }
        ]
      }
    ])
  })

  it('projects command handlers and normalized keybindings for consent and dispatch', async () => {
    const commandManifest = pluginManifestSchema.parse({
      ...manifest,
      contributes: {
        commands: [{ id: 'tasks', title: 'Open Tasks', context: 'worktree', action: 'view.tasks' }],
        keybindings: [{ command: 'tasks', key: 'mod+alt+t' }]
      }
    })
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest: commandManifest,
      consentFingerprint: 'sha256-current',
      consentContentHash: 'a'.repeat(64),
      contentHash: null,
      isDev: true
    }

    expect(
      (
        await buildPluginList(
          serviceWith(plugin, {
            commands: [
              {
                pluginKey: plugin.pluginKey,
                id: 'tasks',
                title: 'Open Tasks',
                context: 'worktree',
                handler: { type: 'built-in', action: 'view.tasks' },
                keybindings: [{ key: 'Mod+Alt+T', when: 'worktree' }]
              }
            ]
          }),
          emptyPluginLockfile()
        )
      )[0]?.commands
    ).toEqual([
      {
        id: 'tasks',
        title: 'Open Tasks',
        context: 'worktree',
        handler: { type: 'built-in', action: 'view.tasks' },
        keybindings: [{ key: 'Mod+Alt+T', when: 'worktree' }]
      }
    ])
  })

  it('projects a contributed task source with its title and icon', async () => {
    const taskSourceManifest = pluginManifestSchema.parse({
      ...manifest,
      main: 'dist/worker.js',
      contributes: {
        taskSources: [{ id: 'issues', title: 'Issues', icon: 'ticket' }]
      }
    })
    const plugin: ValidDiscoveredPlugin = {
      pluginKey: 'orca-samples.demo',
      rootDir: join(tmpdir(), 'plugins', 'demo'),
      manifest: taskSourceManifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }

    expect(
      (
        await buildPluginList(
          serviceWith(plugin, { activation: 'approved' }),
          emptyPluginLockfile()
        )
      )[0]?.taskSources
    ).toEqual([{ id: 'issues', title: 'Issues', icon: 'ticket' }])
  })
})

describe('buildPluginList task source icons', () => {
  function iconManifest(icon: string): typeof manifest {
    return pluginManifestSchema.parse({
      manifestVersion: 1,
      id: 'demo',
      publisher: 'orca-samples',
      name: 'Demo',
      version: '1.0.0',
      engines: { orca: '>=1.0.0' },
      pluginApi: 1,
      main: 'main.mjs',
      contributes: {
        panels: [],
        commands: [],
        events: [],
        taskSources: [{ id: 'boards', title: 'Boards', icon }]
      },
      capabilities: [{ kind: 'workspace:read' }]
    })
  }

  async function pluginRoot(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'orca-plugin-icon-'))
    await writeFile(join(dir, 'main.mjs'), 'export default {}')
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(dir, name), contents)
    }
    return dir
  }

  function discovered(
    pluginKey: string,
    rootDir: string,
    pluginManifest: typeof manifest
  ): ValidDiscoveredPlugin {
    return {
      pluginKey,
      rootDir,
      manifest: pluginManifest,
      consentFingerprint: 'sha256-current',
      contentHash: null,
      isDev: true
    }
  }

  it('projects an accepted icon as a base64 data URL', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>'
    const rootDir = await pluginRoot({ 'boards.svg': svg })
    const plugin = discovered('orca-samples.demo', rootDir, iconManifest('./boards.svg'))

    const [entry] = await buildPluginList(serviceWith(plugin), emptyPluginLockfile())

    expect(entry?.taskSources[0]).toEqual({
      id: 'boards',
      title: 'Boards',
      icon: 'boards.svg',
      iconDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
    })
  })

  it('degrades a missing icon file to no icon instead of failing the listing', async () => {
    const rootDir = await pluginRoot({})
    const plugin = discovered('orca-samples.demo', rootDir, iconManifest('boards.svg'))

    const [entry] = await buildPluginList(serviceWith(plugin), emptyPluginLockfile())

    expect(entry?.taskSources[0]).toEqual({ id: 'boards', title: 'Boards', icon: 'boards.svg' })
  })

  it('degrades a rejected icon without disturbing the other plugins in the listing', async () => {
    const hostileRoot = await pluginRoot({
      'boards.svg': '<svg xmlns="http://www.w3.org/2000/svg" onload="fetch(1)"/>'
    })
    const cleanSvg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>'
    const cleanRoot = await pluginRoot({ 'boards.svg': cleanSvg })
    const hostile = discovered('orca-samples.hostile', hostileRoot, iconManifest('boards.svg'))
    const clean = discovered('orca-samples.clean', cleanRoot, iconManifest('boards.svg'))
    const service = Object.assign(serviceWith(hostile), {
      getDiscovered: () => [hostile, clean]
    })

    const entries = await buildPluginList(service, emptyPluginLockfile())

    expect(entries[0]?.taskSources[0]).toEqual({
      id: 'boards',
      title: 'Boards',
      icon: 'boards.svg'
    })
    expect(entries[1]?.taskSources[0]?.iconDataUrl).toBe(
      `data:image/svg+xml;base64,${Buffer.from(cleanSvg, 'utf8').toString('base64')}`
    )
  })
})
