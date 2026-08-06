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
})
