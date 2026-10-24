import type { PluginContentVerifier } from '../plugin-content-integrity'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from '../plugin-discovery'
import { PluginLanguagePackRegistry } from './plugin-language-pack-registry'
import { PluginIconThemeRegistry } from './plugin-icon-theme-registry'
import { PluginSyntaxRegistry } from './plugin-syntax-registry'
import {
  createPluginTerminalThemeRegistry,
  createPluginThemeRegistry
} from './plugin-theme-registries'
import { PluginVmRecipeRegistry } from '../plugin-vm-recipe-registry'
import { PluginCommandRegistry } from '../plugin-command-registry'
import { verifyInstructionalPluginContent } from '../plugin-instructional-content-integrity'
import type { KeybindingOverrides } from '../../../shared/keybindings'

type ContentFamily = {
  reconcile: (
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ) => Promise<void>
  error: (pluginKey: string) => string | null
}

export class PluginContentPackRegistry {
  readonly languagePacks: PluginLanguagePackRegistry
  readonly themes: ReturnType<typeof createPluginThemeRegistry>
  readonly terminalThemes: ReturnType<typeof createPluginTerminalThemeRegistry>
  readonly iconThemes: PluginIconThemeRegistry
  readonly syntaxes: PluginSyntaxRegistry
  readonly vmRecipes: PluginVmRecipeRegistry
  readonly commands: PluginCommandRegistry
  private readonly activationErrors = new Map<string, string>()

  constructor(
    contentVerifier: PluginContentVerifier,
    /** Revocation chokepoint: no caller-supplied predicate can readmit a
     *  killed plugin's language packs, VM recipes, or commands. */
    private readonly isKilled: (pluginKey: string) => boolean
  ) {
    this.languagePacks = new PluginLanguagePackRegistry(contentVerifier)
    this.themes = createPluginThemeRegistry(contentVerifier)
    this.terminalThemes = createPluginTerminalThemeRegistry(contentVerifier)
    this.iconThemes = new PluginIconThemeRegistry(contentVerifier)
    this.syntaxes = new PluginSyntaxRegistry(contentVerifier)
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
        .filter((plugin) => isApproved(plugin) && !this.isKilled(plugin.pluginKey))
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
      // `approvedKeys` is a snapshot from before the awaited verification
      // above, so a kill list arriving during that wait would otherwise still
      // publish. Re-read revocation here, the last gate before publication.
      const approveAtomically = (plugin: ValidDiscoveredPlugin): boolean =>
        approvedKeys.has(plugin.pluginKey) &&
        !excluded.has(plugin.pluginKey) &&
        !this.isKilled(plugin.pluginKey)
      await Promise.all(
        this.families(keybindings).map((family) => family.reconcile(discovered, approveAtomically))
      )

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
    for (const family of this.families()) {
      const error = family.error(pluginKey)
      if (error !== null) {
        return error
      }
    }
    return null
  }

  /** Every contribution family, in error-reporting order; a new family is one entry here. */
  private families(keybindings: KeybindingOverrides = {}): readonly ContentFamily[] {
    return [
      this.languagePacks,
      this.themes,
      this.terminalThemes,
      this.iconThemes,
      this.syntaxes,
      this.vmRecipes,
      {
        reconcile: async (discovered, isApproved) =>
          this.commands.reconcile(discovered, isApproved, keybindings),
        error: (pluginKey) => this.commands.error(pluginKey)
      }
    ]
  }
}
