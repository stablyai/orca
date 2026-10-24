import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import {
  parsePluginVmRecipeArtifact,
  pluginVmRecipeArtifactId,
  type PluginMachineProvider
} from '../../shared/plugins/plugin-vm-recipe-artifact'
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

export type PluginMachineProviderRegistration = {
  pluginKey: string
  pluginRootDir: string
  provider: PluginMachineProvider
}

type PluginContributions = {
  recipes: PluginVmRecipeRegistration[]
  machineProviders: PluginMachineProviderRegistration[]
}

type VmRecipeLoadResult =
  | ({ pluginKey: string; approved: boolean; ids: string[] } & PluginContributions)
  | { pluginKey: string; error: string }

export class PluginVmRecipeRegistry {
  private active: PluginVmRecipeRegistration[] = []
  private activeMachineProviders: PluginMachineProviderRegistration[] = []
  private readonly previews = new Map<string, PluginContributions>()
  private readonly errors = new Map<string, string>()

  list(): readonly PluginVmRecipeRegistration[] {
    return this.active
  }

  listMachineProviders(): readonly PluginMachineProviderRegistration[] {
    return this.activeMachineProviders
  }

  preview(pluginKey: string): readonly PluginVmRecipeRegistration[] {
    return this.previews.get(pluginKey)?.recipes ?? []
  }

  previewMachineProviders(pluginKey: string): readonly PluginMachineProviderRegistration[] {
    return this.previews.get(pluginKey)?.machineProviders ?? []
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
          const recipes: PluginVmRecipeRegistration[] = []
          const machineProviders: PluginMachineProviderRegistration[] = []
          const ids: string[] = []
          for (const contribution of plugin.manifest.contributes.vmRecipes) {
            const artifact = parsePluginVmRecipeArtifact(
              await readContainedPluginArtifactText(
                plugin.rootDir,
                contribution.path,
                PLUGIN_VM_RECIPE_MAX_BYTES
              )
            )
            const id = pluginVmRecipeArtifactId(artifact)
            if (ids.includes(id)) {
              throw new Error(`duplicate VM recipe id "${id}"`)
            }
            ids.push(id)
            if (artifact.kind === 'recipe') {
              recipes.push({ pluginKey: plugin.pluginKey, recipe: artifact.recipe })
            } else {
              machineProviders.push({
                pluginKey: plugin.pluginKey,
                pluginRootDir: plugin.rootDir,
                provider: artifact.provider
              })
            }
          }
          // Verify after reading so the in-memory commands shown/activated are
          // bound to the exact tree identity the user reviewed.
          await verifyInstructionalPluginContent(plugin)
          return { pluginKey: plugin.pluginKey, approved, ids, recipes, machineProviders }
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
        this.previews.set(result.pluginKey, {
          recipes: result.recipes,
          machineProviders: result.machineProviders
        })
      }
    }
    const approved = results.filter(
      (result): result is Extract<VmRecipeLoadResult, { approved: boolean }> =>
        'approved' in result && result.approved
    )
    const owners = new Map<string, Set<string>>()
    for (const result of approved) {
      for (const id of result.ids) {
        const recipeOwners = owners.get(id) ?? new Set<string>()
        recipeOwners.add(result.pluginKey)
        owners.set(id, recipeOwners)
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
    const active = approved.filter((result) => !conflicted.has(result.pluginKey))
    this.active = active.flatMap((result) => result.recipes)
    this.activeMachineProviders = active.flatMap((result) => result.machineProviders)
  }
}
