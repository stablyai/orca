import { WORKTREE_CREATE_ON_RECIPE_METHOD } from '../../../../../shared/remote-runtime/ephemeral-vm-recipes/recipe-workspace-create-contract'
import { WorktreeCreateOnRecipe } from '../../../../../shared/rpc-contract/workspaces/worktree-create-on-recipe-params'
import { hostQualifiedRepoSelector } from '../../../workspaces/catalog/runtime-repo-selector'
import { defineMethod } from '../../core'

export const WORKTREE_CREATE_ON_RECIPE_RPC_METHOD = defineMethod({
  name: WORKTREE_CREATE_ON_RECIPE_METHOD,
  permission: 'workspace',
  params: WorktreeCreateOnRecipe,
  handler: async (params, context) => {
    // Why: a recipe starts a billed machine from this computer's orca.yaml; only this computer's
    // own CLI may ask, never a paired device or a plugin.
    if (
      context.clientKind !== undefined ||
      context.caller?.kind !== 'local-cli' ||
      context.plugin !== undefined
    ) {
      throw Object.assign(
        new Error(
          'Recipe workspaces are created by the Orca CLI on the computer whose repo declares the recipe, not by a paired device or a plugin.'
        ),
        { code: 'forbidden' }
      )
    }
    const repo = await context.runtime.showRepo(
      hostQualifiedRepoSelector(params.repo, params.repoHostId)
    )
    return context.runtime.createRecipeWorkspace(params, repo, {
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.reportProgress ? { onProgress: context.reportProgress } : {})
    })
  }
})
