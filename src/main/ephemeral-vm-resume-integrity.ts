import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import {
  getEphemeralVmRecipeResultCheckoutMode,
  getEphemeralVmRecipeResultConnection,
  getEphemeralVmRecipeResultProjectRoot,
  type EphemeralVmRecipeResult
} from '../shared/ephemeral-vm-recipes'

export function getProvisionedRootResumeIntegrityError(
  previous: EphemeralVmRecipeResult,
  resumed: EphemeralVmRecipeResult
): string | null {
  if (getEphemeralVmRecipeResultCheckoutMode(previous) !== 'provisioned-root') {
    return null
  }
  if (
    normalizeRuntimePathForComparison(getEphemeralVmRecipeResultProjectRoot(previous)) !==
    normalizeRuntimePathForComparison(getEphemeralVmRecipeResultProjectRoot(resumed))
  ) {
    return 'The provisioned workspace root changed while the runtime was suspended.'
  }
  const previousConnection = getEphemeralVmRecipeResultConnection(previous)
  const resumedConnection = getEphemeralVmRecipeResultConnection(resumed)
  if (previousConnection.type !== resumedConnection.type) {
    return 'The provisioned workspace connection type changed while the runtime was suspended.'
  }
  if (
    previousConnection.type === 'ssh' &&
    resumedConnection.type === 'ssh' &&
    sshOwnershipChanged(previousConnection.target, resumedConnection.target)
  ) {
    return 'The provisioned workspace SSH ownership changed while the runtime was suspended.'
  }
  return null
}

const SSH_OWNERSHIP_FIELDS = [
  'configHost',
  'username',
  'identityFile',
  'identityAgent',
  'identitiesOnly',
  'proxyCommand',
  'jumpHost'
] as const

function sshOwnershipChanged(
  previous: Extract<
    ReturnType<typeof getEphemeralVmRecipeResultConnection>,
    { type: 'ssh' }
  >['target'],
  resumed: Extract<
    ReturnType<typeof getEphemeralVmRecipeResultConnection>,
    { type: 'ssh' }
  >['target']
): boolean {
  return SSH_OWNERSHIP_FIELDS.some((field) => previous[field] !== resumed[field])
}
