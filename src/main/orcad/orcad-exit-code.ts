import { OrcadBindAddressError } from '../../shared/orcad-bind-address'
import { OrcadBundledRuntimeError } from './orcad-bundled-runtime'
import { OrcadInstanceLockError } from './orcad-data-root-privacy'
import { ProfileStateAccessError } from '../persistence/profile-state/access/profile-state-access-error'
import { ORCAD_EXIT_CONFIGURATION } from './orcad-configuration-exit'
import { SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE } from '../../shared/single-instance-exit-code'
import { ORCAD_EXIT_TERMINALS_NOT_DURABLE } from '../../shared/serve-supervised-terminal-durability'
import { OrcadTerminalsNotDurableError } from './orcad-serve-supervision'

export const ORCAD_EXIT_FAILED = 1

export function resolveOrcadExitCode(error: unknown): number {
  // Supervisors wait for an existing holder instead of abandoning the host.
  if (
    error instanceof OrcadInstanceLockError &&
    error.code === 'orcad_instance_lock_holder_unverifiable'
  ) {
    return SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
  }
  if (error instanceof OrcadTerminalsNotDurableError) {
    return ORCAD_EXIT_TERMINALS_NOT_DURABLE
  }
  return error instanceof OrcadInstanceLockError ||
    error instanceof OrcadBindAddressError ||
    error instanceof OrcadBundledRuntimeError ||
    error instanceof ProfileStateAccessError
    ? ORCAD_EXIT_CONFIGURATION
    : ORCAD_EXIT_FAILED
}
