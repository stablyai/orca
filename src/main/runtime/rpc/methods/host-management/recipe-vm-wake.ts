import {
  RECIPE_VM_WAKE_METHOD,
  RecipeVmWakeUnavailableError
} from '../../../../../shared/remote-runtime/recipe-vm-wake'
import { RecipeVmWakeParams } from '../../../../../shared/rpc-contract/host-management/recipe-vm-wake-params'
import { getRecipeVmWaker } from '../../../workspaces/sleep/recipe-vm-waker-registry'
import { defineMethod } from '../../core'

export const RECIPE_VM_WAKE_METHODS = [
  // The CLI reaches a recipe VM's server directly, so it asks this desktop, the VM's owner, to
  // open it; the desktop holds the call until the VM is up, as it does any client's open.
  defineMethod({
    name: RECIPE_VM_WAKE_METHOD,
    permission: 'workspace',
    params: RecipeVmWakeParams,
    handler: async ({ environment }) => {
      const waker = getRecipeVmWaker()
      if (!waker) {
        throw new RecipeVmWakeUnavailableError()
      }
      return { opening: await waker.openEnvironment(environment) }
    }
  })
]
