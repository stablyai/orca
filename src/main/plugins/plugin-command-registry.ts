import {
  pluginCommandKeybindingActionId,
  type PluginCommandAliasActionId
} from '../../shared/plugins/plugin-command-actions'
import { getKeybindingConflictIdentity, type KeybindingOverrides } from '../../shared/keybindings'
import type {
  PluginCommandContribution,
  PluginManifest
} from '../../shared/plugins/plugin-manifest'
import type { PluginKeybindingContribution } from '../../shared/plugins/plugin-content-pack-contributions'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'

export type PluginCommandKeybinding = {
  key: string
  when: 'global' | 'worktree'
}

export type PluginCommandRegistration = {
  pluginKey: string
  id: string
  title: string
  context: 'global' | 'worktree'
  handler: { type: 'built-in'; action: PluginCommandAliasActionId } | { type: 'worker' }
  keybindings: PluginCommandKeybinding[]
}

type CommandOwner = {
  pluginKey: string
  context: PluginCommandKeybinding['when']
  key: string
}

export class PluginCommandRegistry {
  private active: PluginCommandRegistration[] = []
  private readonly previews = new Map<string, PluginCommandRegistration[]>()
  private readonly errors = new Map<string, string>()

  list(): readonly PluginCommandRegistration[] {
    return this.active
  }

  preview(pluginKey: string): readonly PluginCommandRegistration[] {
    return this.previews.get(pluginKey) ?? []
  }

  error(pluginKey: string): string | null {
    return this.errors.get(pluginKey) ?? null
  }

  reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean,
    overrides: KeybindingOverrides = {},
    platform: NodeJS.Platform = process.platform
  ): void {
    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) && plugin.manifest.contributes.commands.length > 0
    )
    const registrations = candidates.map((plugin) => ({
      pluginKey: plugin.pluginKey,
      approved: isApproved(plugin),
      commands: registrationsForManifest(plugin.pluginKey, plugin.manifest)
    }))

    this.previews.clear()
    this.errors.clear()
    for (const plugin of registrations) {
      this.previews.set(plugin.pluginKey, plugin.commands)
    }

    const approved = registrations.filter((plugin) => plugin.approved)
    const chordOwners = new Map<string, CommandOwner[]>()
    for (const plugin of approved) {
      for (const command of plugin.commands) {
        for (const keybinding of effectiveCommandKeybindings(command, overrides)) {
          const identity = getKeybindingConflictIdentity(keybinding.key, platform)
          const owners = chordOwners.get(identity) ?? []
          owners.push({
            pluginKey: plugin.pluginKey,
            context: keybinding.when,
            key: keybinding.key
          })
          chordOwners.set(identity, owners)
        }
      }
    }

    const conflicted = new Set<string>()
    for (const owners of chordOwners.values()) {
      for (let index = 0; index < owners.length; index += 1) {
        for (let compared = index + 1; compared < owners.length; compared += 1) {
          const first = owners[index]!
          const second = owners[compared]!
          if (!contextsOverlap(first.context, second.context)) {
            continue
          }
          conflicted.add(first.pluginKey)
          conflicted.add(second.pluginKey)
          this.errors.set(
            first.pluginKey,
            `plugin keybinding ${first.key} conflicts with another plugin`
          )
          this.errors.set(
            second.pluginKey,
            `plugin keybinding ${second.key} conflicts with another plugin`
          )
        }
      }
    }

    this.active = approved
      .filter((plugin) => !conflicted.has(plugin.pluginKey))
      .flatMap((plugin) => plugin.commands)
  }
}

function effectiveCommandKeybindings(
  command: PluginCommandRegistration,
  overrides: KeybindingOverrides
): PluginCommandKeybinding[] {
  const override = overrides[pluginCommandKeybindingActionId(command.pluginKey, command.id)]
  if (!Array.isArray(override)) {
    return command.keybindings
  }
  return override.map((key) => ({ key, when: command.context }))
}

function registrationsForManifest(
  pluginKey: string,
  manifest: PluginManifest
): PluginCommandRegistration[] {
  return manifest.contributes.commands.map((command) => ({
    pluginKey,
    id: command.id,
    title: command.title,
    context: command.context ?? 'global',
    handler:
      command.action === undefined
        ? { type: 'worker' as const }
        : { type: 'built-in' as const, action: command.action as PluginCommandAliasActionId },
    keybindings: keybindingsForCommand(command, manifest.contributes.keybindings)
  }))
}

function keybindingsForCommand(
  command: PluginCommandContribution,
  keybindings: readonly PluginKeybindingContribution[]
): PluginCommandKeybinding[] {
  return keybindings
    .filter((keybinding) => keybinding.command === command.id)
    .map((keybinding) => ({
      key: keybinding.key,
      when: keybinding.when ?? command.context ?? 'global'
    }))
}

function contextsOverlap(
  first: PluginCommandKeybinding['when'],
  second: PluginCommandKeybinding['when']
): boolean {
  return first === 'global' || second === 'global' || first === second
}
