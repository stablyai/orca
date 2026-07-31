import type { OrcaVmRecipe } from '../../shared/types'
import { parsePluginVmRecipeArtifact } from '../../shared/plugins/plugin-vm-recipe-artifact'
import {
  PLUGIN_VM_RECIPE_MAX_BYTES,
  readContainedPluginArtifactText
} from './plugin-artifact-validation'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import {
  isInvalidDiscoveredPlugin,
  type DiscoveredPlugin,
  type ValidDiscoveredPlugin
} from './plugin-discovery'
import { verifyInstructionalPluginContent } from './plugin-instructional-content-integrity'

const VM_RECIPE_LOAD_CONCURRENCY = 4

export type PluginVmRecipeRegistration = {
  pluginKey: string
  recipe: OrcaVmRecipe
}

type VmRecipeLoadResult =
  | {
      pluginKey: string
      approved: boolean
      registrations: PluginVmRecipeRegistration[]
    }
  | { pluginKey: string; error: string }

export class PluginVmRecipeRegistry {
  private active: PluginVmRecipeRegistration[] = []
  private readonly previews = new Map<string, PluginVmRecipeRegistration[]>()
  private readonly errors = new Map<string, string>()

  list(): readonly PluginVmRecipeRegistration[] {
    return this.active
  }

  preview(pluginKey: string): readonly PluginVmRecipeRegistration[] {
    return this.previews.get(pluginKey) ?? []
  }

  error(pluginKey: string): string | null {
    return this.errors.get(pluginKey) ?? null
  }

  async reconcile(
    discovered: readonly DiscoveredPlugin[],
    isApproved: (plugin: ValidDiscoveredPlugin) => boolean
  ): Promise<void> {
    const candidates = discovered.filter(
      (plugin): plugin is ValidDiscoveredPlugin =>
        !isInvalidDiscoveredPlugin(plugin) && plugin.manifest.contributes.vmRecipes.length > 0
    )
    const results = await mapWithConcurrency(
      candidates,
      VM_RECIPE_LOAD_CONCURRENCY,
      async (plugin): Promise<VmRecipeLoadResult> => {
        try {
          const approved = isApproved(plugin)
          const registrations: PluginVmRecipeRegistration[] = []
          const seen = new Set<string>()
          for (const contribution of plugin.manifest.contributes.vmRecipes) {
            const recipe = parsePluginVmRecipeArtifact(
              await readContainedPluginArtifactText(
                plugin.rootDir,
                contribution.path,
                PLUGIN_VM_RECIPE_MAX_BYTES
              )
            )
            if (seen.has(recipe.id)) {
              throw new Error(`duplicate VM recipe id "${recipe.id}"`)
            }
            seen.add(recipe.id)
            registrations.push({ pluginKey: plugin.pluginKey, recipe })
          }
          // Verify after reading so the in-memory commands shown/activated are
          // bound to the exact tree identity the user reviewed.
          await verifyInstructionalPluginContent(plugin)
          return { pluginKey: plugin.pluginKey, approved, registrations }
        } catch (error) {
          return {
            pluginKey: plugin.pluginKey,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }
    )

    this.previews.clear()
    this.errors.clear()
    for (const result of results) {
      if ('error' in result) {
        this.errors.set(result.pluginKey, result.error)
      } else {
        this.previews.set(result.pluginKey, result.registrations)
      }
    }
    const approved = results.filter(
      (result): result is Extract<VmRecipeLoadResult, { approved: boolean }> =>
        'approved' in result && result.approved
    )
    const owners = new Map<string, Set<string>>()
    for (const result of approved) {
      for (const registration of result.registrations) {
        const recipeOwners = owners.get(registration.recipe.id) ?? new Set<string>()
        recipeOwners.add(result.pluginKey)
        owners.set(registration.recipe.id, recipeOwners)
      }
    }
    const conflicted = new Set<string>()
    for (const [recipeId, recipeOwners] of owners) {
      if (recipeOwners.size > 1) {
        for (const pluginKey of recipeOwners) {
          conflicted.add(pluginKey)
          this.errors.set(
            pluginKey,
            `VM recipe id "${recipeId}" is contributed by multiple plugins`
          )
        }
      }
    }
    this.active = approved
      .filter((result) => !conflicted.has(result.pluginKey))
      .flatMap((result) => result.registrations)
  }
}
