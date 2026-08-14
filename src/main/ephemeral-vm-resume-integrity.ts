import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultProjectRoot,
  type EphemeralVmRecipeResult
} from '../shared/ephemeral-vm-recipes'

export function provisionedRootChangedDuringResume(
  previous: EphemeralVmRecipeResult,
  resumed: EphemeralVmRecipeResult
): boolean {
  if (getEphemeralVmRecipeResultCheckoutMode(previous) !== 'provisioned-root') {
    return false
  }
  return (
    normalizeRuntimePathForComparison(getEphemeralVmRecipeResultProjectRoot(previous)) !==
    normalizeRuntimePathForComparison(getEphemeralVmRecipeResultProjectRoot(resumed))
  )
}
