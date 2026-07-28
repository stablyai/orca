import type { PluginContentVerifier } from './plugin-content-integrity'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { PluginLanguagePackRegistry } from './plugin-language-pack-registry'
import { PluginIconThemeRegistry } from './plugin-icon-theme-registry'
import { PluginThemeRegistry } from './plugin-theme-registry'
import { PluginTerminalThemeRegistry } from './plugin-terminal-theme-registry'
import { PluginVmRecipeRegistry } from './plugin-vm-recipe-registry'
import { PluginCommandRegistry } from './plugin-command-registry'
import { verifyInstructionalPluginContent } from './plugin-instructional-content-integrity'
import type { KeybindingOverrides } from '../../shared/keybindings'

export class PluginContentPackRegistry {
  readonly themes: PluginThemeRegistry
  readonly languagePacks: PluginLanguagePackRegistry
  readonly iconThemes: PluginIconThemeRegistry
  readonly terminalThemes: PluginTerminalThemeRegistry
  readonly vmRecipes: PluginVmRecipeRegistry
  readonly commands: PluginCommandRegistry
  private readonly activationErrors = new Map<string, string>()

  constructor(contentVerifier: PluginContentVerifier) {
    this.themes = new PluginThemeRegistry(contentVerifier)
    this.languagePacks = new PluginLanguagePackRegistry(contentVerifier)
    this.iconThemes = new PluginIconThemeRegistry(contentVerifier)
    this.terminalThemes = new PluginTerminalThemeRegistry(contentVerifier)
    this.vmRecipes = new PluginVmRecipeRegistry()
    this.commands = new PluginCommandRegistry()
  }

  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean,
    keybindings: KeybindingOverrides = {}
  ): Promise<void> {
    const approvedKeys = new Set(
      discovered
        .filter((plugin): plugin is ValidDiscoveredPlugin => !isInvalidDiscoveredPlugin(plugin))
        .filter(isApproved)
        .map((plugin) => plugin.pluginKey)
    )
    const excluded = new Set<string>()
    this.activationErrors.clear()

    await Promise.all(
      discovered.map(async (plugin) => {
        if (
          isInvalidDiscoveredPlugin(plugin) ||
          !approvedKeys.has(plugin.pluginKey) ||
          plugin.manifest.contributes.vmRecipes.length > 0
        ) {
          return
        }
        try {
          await verifyInstructionalPluginContent(plugin)
        } catch (error) {
          excluded.add(plugin.pluginKey)
          this.activationErrors.set(
            plugin.pluginKey,
            error instanceof Error ? error.message : String(error)
          )
        }
      })
    )

    while (true) {
      const approveAtomically = (plugin: ValidDiscoveredPlugin): boolean =>
        approvedKeys.has(plugin.pluginKey) && !excluded.has(plugin.pluginKey)
      await Promise.all([
        this.themes.reconcile(discovered, approveAtomically),
        this.languagePacks.reconcile(discovered, approveAtomically),
        this.iconThemes.reconcile(discovered, approveAtomically),
        this.terminalThemes.reconcile(discovered, approveAtomically),
        this.vmRecipes.reconcile(discovered, approveAtomically),
        this.commands.reconcile(discovered, approveAtomically, keybindings)
      ])

      let foundNewError = false
      for (const pluginKey of approvedKeys) {
        const error = this.registryError(pluginKey)
        if (error && !excluded.has(pluginKey)) {
          excluded.add(pluginKey)
          this.activationErrors.set(pluginKey, error)
          foundNewError = true
        }
      }
      if (!foundNewError) {
        break
      }
    }
  }

  error(pluginKey: string): string | null {
    return this.activationErrors.get(pluginKey) ?? this.registryError(pluginKey)
  }

  private registryError(pluginKey: string): string | null {
    return (
      this.themes.error(pluginKey) ??
      this.languagePacks.error(pluginKey) ??
      this.iconThemes.error(pluginKey) ??
      this.terminalThemes.error(pluginKey) ??
      this.vmRecipes.error(pluginKey) ??
      this.commands.error(pluginKey)
    )
  }
}
