import { describe, expect, it } from 'vitest'
import { fingerprintPluginConsent } from '../../shared/plugins/plugin-consent-fingerprint'
import { pluginManifestSchema } from '../../shared/plugins/plugin-manifest'
import type { ValidDiscoveredPlugin } from './plugin-discovery'
import { PluginCommandRegistry } from './plugin-command-registry'

function commandPlugin(
  id: string,
  contributes: {
    commands: Record<string, unknown>[]
    keybindings?: Record<string, unknown>[]
  }
): ValidDiscoveredPlugin {
  const manifest = pluginManifestSchema.parse({
    manifestVersion: 1,
    id,
    publisher: 'orca-samples',
    name: id,
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    ...(contributes.commands.some((command) => command.action === undefined)
      ? { main: 'worker.js' }
      : {}),
    contributes,
    capabilities: []
  })
  return {
    pluginKey: `orca-samples.${id}`,
    rootDir: `/plugins/${id}`,
    manifest,
    consentFingerprint: fingerprintPluginConsent(manifest, `content-${id}`),
    consentContentHash: `content-${id}`,
    contentHash: `content-${id}`,
    isDev: false
  }
}

describe('PluginCommandRegistry', () => {
  it('reads binding command IDs once while preserving declaration and binding order', () => {
    const commands = Array.from({ length: 256 }, (_, index) => ({
      id: `command-${index}`,
      title: `Command ${index}`,
      action: 'view.tasks'
    }))
    const keys = Array.from(
      { length: 104 },
      (_, index) =>
        `Mod+${Math.floor(index / 26) & 1 ? 'Alt+' : ''}${Math.floor(index / 26) & 2 ? 'Shift+' : ''}${String.fromCharCode(65 + (index % 26))}`
    )
    // Distinct physical chords, with two bindings belonging to the same command.
    const uniqueKeys = [...new Set(keys)]
    const plugin = commandPlugin('many-commands', {
      commands,
      keybindings: uniqueKeys.map((key, index) => ({ command: `command-${index % 32}`, key }))
    })
    let reads = 0
    for (const binding of plugin.manifest.contributes.keybindings) {
      const command = binding.command
      Object.defineProperty(binding, 'command', {
        get: () => {
          reads++
          return command
        }
      })
    }
    const registry = new PluginCommandRegistry()
    registry.reconcile([plugin], () => false)
    const preview = registry.preview(plugin.pluginKey)
    expect(preview.map((command) => command.id)).toEqual(commands.map((command) => command.id))
    expect(preview[0].keybindings.map((binding) => binding.key)).toEqual(
      plugin.manifest.contributes.keybindings
        .filter((_, index) => index % 32 === 0)
        .map((binding) => binding.key)
    )
    expect(preview[255].keybindings).toEqual([])
    expect(registry.list()).toEqual([])
    expect(reads).toBe(uniqueKeys.length)
  })

  it('retains pending previews and exposes only approved commands', () => {
    const plugin = commandPlugin('aliases', {
      commands: [{ id: 'tasks', title: 'Open Tasks', action: 'view.tasks' }],
      keybindings: [{ command: 'tasks', key: 'mod+alt+t' }]
    })
    const registry = new PluginCommandRegistry()

    registry.reconcile([plugin], () => false)
    expect(registry.list()).toEqual([])
    expect(registry.preview(plugin.pluginKey)).toEqual([
      {
        pluginKey: plugin.pluginKey,
        id: 'tasks',
        title: 'Open Tasks',
        context: 'global',
        handler: { type: 'built-in', action: 'view.tasks' },
        keybindings: [{ key: 'Mod+Alt+T', when: 'global' }]
      }
    ])

    registry.reconcile([plugin], () => true)
    expect(registry.list()).toHaveLength(1)
  })

  it('projects worker commands and inherited worktree keybinding context', () => {
    const plugin = commandPlugin('worker', {
      commands: [{ id: 'create', title: 'Create Task', context: 'worktree' }],
      keybindings: [{ command: 'create', key: 'Mod+Shift+A' }]
    })
    const registry = new PluginCommandRegistry()

    registry.reconcile([plugin], () => true)

    expect(registry.list()).toMatchObject([
      {
        context: 'worktree',
        handler: { type: 'worker' },
        keybindings: [{ key: 'Mod+Shift+A', when: 'worktree' }]
      }
    ])
  })

  it('errors approved plugins whose keybindings overlap', () => {
    const global = commandPlugin('global', {
      commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }],
      keybindings: [{ command: 'tasks', key: 'Mod+Alt+T', when: 'global' }]
    })
    const worktree = commandPlugin('worktree', {
      commands: [{ id: 'tasks', title: 'Tasks', context: 'worktree', action: 'view.tasks' }],
      keybindings: [{ command: 'tasks', key: 'Mod+Alt+T', when: 'worktree' }]
    })
    const registry = new PluginCommandRegistry()

    registry.reconcile([global, worktree], () => true)

    expect(registry.list()).toEqual([])
    expect(registry.error(global.pluginKey)).toContain('conflicts')
    expect(registry.error(worktree.pluginKey)).toContain('conflicts')
  })

  it('uses saved effective bindings to recover conflicting plugins', () => {
    const first = commandPlugin('first', {
      commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }],
      keybindings: [{ command: 'tasks', key: 'Mod+Alt+T' }]
    })
    const second = commandPlugin('second', {
      commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }],
      keybindings: [{ command: 'tasks', key: 'Mod+Alt+T' }]
    })
    const registry = new PluginCommandRegistry()

    registry.reconcile(
      [first, second],
      () => true,
      { 'plugin:orca-samples.first/tasks': ['Mod+Shift+T'] },
      'linux'
    )

    expect(registry.list()).toHaveLength(2)
    expect(registry.error(first.pluginKey)).toBeNull()
    expect(registry.error(second.pluginKey)).toBeNull()
  })

  it('rejects conflicting saved bindings within one plugin', () => {
    const plugin = commandPlugin('aliases', {
      commands: [
        { id: 'tasks', title: 'Tasks', action: 'view.tasks' },
        { id: 'sidebar', title: 'Sidebar', action: 'sidebar.left.toggle' }
      ]
    })
    const registry = new PluginCommandRegistry()

    registry.reconcile(
      [plugin],
      () => true,
      {
        'plugin:orca-samples.aliases/tasks': ['Mod+Alt+T'],
        'plugin:orca-samples.aliases/sidebar': ['Mod+Alt+T']
      },
      'linux'
    )

    expect(registry.list()).toEqual([])
    expect(registry.error(plugin.pluginKey)).toContain('conflicts')
  })

  it('detects cross-platform Mod and physical Ctrl conflicts', () => {
    const portable = commandPlugin('portable', {
      commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }],
      keybindings: [{ command: 'tasks', key: 'Mod+Alt+T' }]
    })
    const physical = commandPlugin('physical', {
      commands: [{ id: 'tasks', title: 'Tasks', action: 'view.tasks' }],
      keybindings: [{ command: 'tasks', key: 'Ctrl+Alt+T' }]
    })
    const registry = new PluginCommandRegistry()

    registry.reconcile([portable, physical], () => true, {}, 'linux')

    expect(registry.list()).toEqual([])
    expect(registry.error(portable.pluginKey)).toContain('conflicts')
    expect(registry.error(physical.pluginKey)).toContain('conflicts')
  })

  it('allows the same worktree-only chord after one plugin is disabled', () => {
    const first = commandPlugin('first', {
      commands: [{ id: 'tasks', title: 'Tasks', context: 'worktree', action: 'view.tasks' }],
      keybindings: [{ command: 'tasks', key: 'Mod+Alt+T' }]
    })
    const second = commandPlugin('second', {
      commands: [{ id: 'tasks', title: 'Tasks', context: 'worktree', action: 'view.tasks' }],
      keybindings: [{ command: 'tasks', key: 'Mod+Alt+T' }]
    })
    const registry = new PluginCommandRegistry()

    registry.reconcile([first, second], (plugin) => plugin === first)

    expect(registry.list()).toHaveLength(1)
    expect(registry.error(first.pluginKey)).toBeNull()
  })
})
