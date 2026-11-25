import type { RemoteRuntimeSharedControlConnectionOptions } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'
import type { RuntimeCapability } from '../../../../shared/remote-runtime/protocol/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { IDLE_PASSIVE_CONTROL_CLIENT_CAPABILITY } from '../../../../shared/remote-runtime/protocol/orcad-runtime-capabilities'
import { isRuntimeEnvironmentCapabilityPaused } from './runtime-environment-capability-evidence'
import { isRuntimeEnvironmentManuallyDisconnected } from '../connectivity/runtime-environment-manual-disconnect'
import { handleSharedControlRefusal } from '../pairing/runtime-environment-pairing-refusal-registry'
import { traceSharedControlSocketClose } from '../status/runtime-environment-control-socket-close-trace'
import { prepareRecipeVmServerSleepCheck } from '../../../ephemeral-vm/recipe-vm-asleep'
import { isWslOrcadEnvironmentId } from '../../../wsl/orcad/wsl-orcad-environment-id'
import {
  isWslHostIdleStopped,
  noteWslHostIdleStop
} from '../../../wsl/host-lifecycle/wsl-host-idle-stop'

/** When a shared control socket may reconnect, who answers a refused token, and where closes go. */
export function sharedControlEnvironmentPolicy(
  environmentId: string
): Pick<
  RemoteRuntimeSharedControlConnectionOptions,
  | 'clientCapabilities'
  | 'isManuallyDisconnected'
  | 'isCapabilityPaused'
  | 'isIdleStopped'
  | 'onIdleStop'
  | 'prepareSleepCheck'
  | 'onAuthenticationRejected'
  | 'onSocketClosed'
> {
  return {
    clientCapabilities: desktopRuntimeClientCapabilities(environmentId),
    isManuallyDisconnected: () => isRuntimeEnvironmentManuallyDisconnected(environmentId),
    isCapabilityPaused: () => isRuntimeEnvironmentCapabilityPaused(environmentId),
    // Only a WSL host has a wake for its hold; any other server's idle-stop close is a plain close.
    ...(isWslOrcadEnvironmentId(environmentId)
      ? {
          isIdleStopped: () => isWslHostIdleStopped(environmentId),
          onIdleStop: () => noteWslHostIdleStop(environmentId)
        }
      : {}),
    prepareSleepCheck: () => prepareRecipeVmServerSleepCheck(environmentId),
    onAuthenticationRejected: () => handleSharedControlRefusal(environmentId),
    onSocketClosed: (record) => traceSharedControlSocketClose(environmentId, record)
  }
}

/**
 * Only a WSL host's sockets are passive, since only WSL wakes a host that idled out under an open
 * desktop; their ordinary requests still count as use. An SSH host stays held up by an open
 * desktop, as before (#46567). An older orcad ignores the unknown capability and stays held.
 */
export function desktopRuntimeClientCapabilities(
  environmentId: string
): readonly RuntimeCapability[] {
  return isWslOrcadEnvironmentId(environmentId)
    ? [...ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES, IDLE_PASSIVE_CONTROL_CLIENT_CAPABILITY]
    : ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
}
