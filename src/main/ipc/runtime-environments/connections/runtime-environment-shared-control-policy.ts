import type { RemoteRuntimeSharedControlConnectionOptions } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { isRuntimeEnvironmentCapabilityPaused } from './runtime-environment-capability-evidence'
import { isRuntimeEnvironmentManuallyDisconnected } from '../connectivity/runtime-environment-manual-disconnect'
import { handleSharedControlRefusal } from '../pairing/runtime-environment-pairing-refusal-registry'
import { traceSharedControlSocketClose } from '../status/runtime-environment-control-socket-close-trace'
import { isRecipeVmServerAsleep } from '../../../ephemeral-vm/recipe-vm-asleep'

/** When a shared control socket may reconnect, who answers a refused token, and where closes go. */
export function sharedControlEnvironmentPolicy(
  environmentId: string
): Pick<
  RemoteRuntimeSharedControlConnectionOptions,
  | 'isManuallyDisconnected'
  | 'isCapabilityPaused'
  | 'isAsleep'
  | 'onAuthenticationRejected'
  | 'onSocketClosed'
> {
  return {
    isManuallyDisconnected: () => isRuntimeEnvironmentManuallyDisconnected(environmentId),
    isCapabilityPaused: () => isRuntimeEnvironmentCapabilityPaused(environmentId),
    isAsleep: () => isRecipeVmServerAsleep(environmentId),
    onAuthenticationRejected: () => handleSharedControlRefusal(environmentId),
    onSocketClosed: (record) => traceSharedControlSocketClose(environmentId, record)
  }
}
