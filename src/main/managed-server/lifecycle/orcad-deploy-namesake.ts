import { findCollidingEnvironmentName } from '../../../shared/remote-runtime/host-catalog/runtime-environment-name-collision'
import {
  getOrcadSshDeployment,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'

/** The saved server whose name refuses a deploy before Orca reaches the host, or undefined. With `moveSavedServer`, servers managed over SSH never refuse here: the store tells by host key whether one is this machine. */
export function findNamesakeBeforeDeploy<
  T extends Pick<KnownRuntimeEnvironment, 'id' | 'name' | 'orcadDeployment'>
>(
  environments: readonly T[],
  args: { name: string; environmentId: string; moveSavedServer: boolean }
): T | undefined {
  return findCollidingEnvironmentName(
    environments.filter(
      (entry) =>
        entry.id !== args.environmentId && !(args.moveSavedServer && getOrcadSshDeployment(entry))
    ),
    args.name
  )
}
