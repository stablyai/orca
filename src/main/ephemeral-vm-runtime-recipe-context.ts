import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'
import type { OrcaVmRecipe } from '../shared/types'

export function getPersistedEphemeralVmRecipe(recipe: OrcaVmRecipe): OrcaVmRecipe {
  if (recipe.checkoutMode !== 'orca-worktree') {
    return recipe
  }
  const persisted = { ...recipe }
  delete persisted.checkoutMode
  return persisted
}

export function getEphemeralVmRuntimeRecipeContext(
  repoPath: string,
  runtime: EphemeralVmRuntimeRecord
): EphemeralVmRecipeContext {
  return {
    instanceId: runtime.id,
    recipeId: runtime.recipeId,
    projectId: runtime.projectId,
    workspaceId: runtime.workspaceId,
    workspaceName: runtime.workspaceName,
    repoUrl: runtime.repoUrl,
    branch: runtime.branch,
    ref: runtime.ref,
    orcaVersion: runtime.orcaVersion,
    repoPath
  }
}
