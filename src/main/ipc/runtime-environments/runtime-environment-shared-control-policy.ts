import type { RemoteRuntimeSharedControlConnectionOptions } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { isRuntimeEnvironmentCapabilityPaused } from './runtime-environment-capability-evidence'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { handleSharedControlRefusal } from './runtime-environment-pairing-refusal-registry'

/** When an environment's shared control socket may reconnect, and who answers a refused token. */
export function sharedControlEnvironmentPolicy(
  environmentId: string
): Pick<
  RemoteRuntimeSharedControlConnectionOptions,
  'isManuallyDisconnected' | 'isCapabilityPaused' | 'onAuthenticationRejected'
> {
  return {
    isManuallyDisconnected: () => isRuntimeEnvironmentManuallyDisconnected(environmentId),
    isCapabilityPaused: () => isRuntimeEnvironmentCapabilityPaused(environmentId),
    onAuthenticationRejected: () => handleSharedControlRefusal(environmentId)
  }
}
