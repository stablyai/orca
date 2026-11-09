import { VmRecipeList } from '../../../../../shared/rpc-contract/vm-recipe-params'
import { defineMethod } from '../../core'

/** The environment recipes `worktree.create` with `recipeId` accepts on this host. */
export const VM_RECIPE_LIST_METHOD = defineMethod({
  name: 'vmRecipe.list',
  permission: 'workspace',
  params: VmRecipeList,
  handler: async (params, { runtime }) => ({
    repos: await runtime.listEnvironmentRecipes(params.repo)
  })
})
