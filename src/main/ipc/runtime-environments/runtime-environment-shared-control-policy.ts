import type { RemoteRuntimeSharedControlConnectionOptions } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import { isRuntimeEnvironmentCapabilityPaused } from './runtime-environment-capability-evidence'
import { isRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'
import { handleSharedControlRefusal } from './runtime-environment-pairing-refusal-registry'
import { traceSharedControlSocketClose } from './runtime-environment-control-socket-close-trace'

/** When a shared control socket may reconnect, who answers a refused token, and where closes go. */
export function sharedControlEnvironmentPolicy(
  environmentId: string
): Pick<
  RemoteRuntimeSharedControlConnectionOptions,
  'isManuallyDisconnected' | 'isCapabilityPaused' | 'onAuthenticationRejected' | 'onSocketClosed'
> {
  return {
    isManuallyDisconnected: () => isRuntimeEnvironmentManuallyDisconnected(environmentId),
    isCapabilityPaused: () => isRuntimeEnvironmentCapabilityPaused(environmentId),
    onAuthenticationRejected: () => handleSharedControlRefusal(environmentId),
    onSocketClosed: (record) => traceSharedControlSocketClose(environmentId, record)
  }
}
