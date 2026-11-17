// Orca Cloud's part of recipe resolution (ephemeral-vm-recipe-context.ts): built-in provider
// recipes and the saved name of an Orca Cloud server.
import type { OrcaVmRecipe } from '../../shared/workspace-setup/orca-yaml-hook-types'
import { orcaCloudEnvironmentName } from '../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'

/** Built-in providers (Orca Cloud) keep their reserved ids and lead the list: a project or plugin
 *  recipe with the same id cannot shadow them. */
export function reserveBuiltInProviderRecipes(
  repoRecipes: readonly OrcaVmRecipe[],
  pluginRecipes: readonly OrcaVmRecipe[]
): { builtIns: OrcaVmRecipe[]; repo: OrcaVmRecipe[]; plugins: OrcaVmRecipe[] } {
  const builtIns = pluginRecipes.filter((recipe) => recipe.provider)
  const reserved = new Set(builtIns.map((recipe) => recipe.id))
  return {
    builtIns,
    repo: repoRecipes.filter((recipe) => !reserved.has(recipe.id)),
    plugins: pluginRecipes.filter((recipe) => !recipe.provider)
  }
}

// Glossary: an Orca Cloud machine is a sandbox; "VM" stays only for bring-your-own recipes.
export function buildEphemeralEnvironmentName(
  repo: string,
  runtimeId: string,
  recipe: { provider?: string }
): string {
  return recipe.provider === 'orca-cloud'
    ? orcaCloudEnvironmentName(repo, runtimeId)
    : `${repo} VM ${runtimeId.slice(-8)}`
}
