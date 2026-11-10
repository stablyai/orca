import { ephemeralVmFailure, type EphemeralVmFailure } from '../../shared/ephemeral-vm-failure-copy'
import { ORCA_CLOUD_RECIPE_ID } from '../../shared/hosted-sandbox/orca-cloud-recipe-id'
import type { OrcaCloudAvailability } from '../../shared/orca-yaml-hook-types'

/**
 * Why a provision found no recipe. Orca Cloud is only listed while it's offered, so a create picked
 * before a sign-out (or a session that expired) says "sign in", not a generic "recipe not found".
 */
export function missingRecipeFailure(
  recipeId: string,
  orcaCloud: () => Promise<OrcaCloudAvailability>
): Promise<EphemeralVmFailure> | EphemeralVmFailure {
  if (recipeId !== ORCA_CLOUD_RECIPE_ID) {
    return ephemeralVmFailure('recipeNotFound', { recipeId })
  }
  return orcaCloud().then((availability) => {
    switch (availability) {
      case 'needs-sign-in':
        return ephemeralVmFailure('cloudSignInRequired')
      case 'needs-capability':
        return ephemeralVmFailure('cloudPlanRequired')
      case 'unavailable':
        return ephemeralVmFailure('cloudUnavailable')
      case 'offered':
        return ephemeralVmFailure('recipeNotFound', { recipeId })
    }
  })
}
