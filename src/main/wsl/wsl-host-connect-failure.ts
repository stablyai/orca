import { errorMessage } from '../../shared/error-message'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime/remote-runtime-client-error'
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'
import {
  WslDistroNotRunningError,
  WslOrcadLaunchDeferredError
} from './wsl-orcad-connection-errors'
import {
  OrcadManagedIdentityError,
  OrcadManagedPairingRejectedError
} from '../managed-server/lifecycle/orcad-managed-tunnel-identity'
import { OrcadManagedPairingRepairFailedError } from '../managed-server/lifecycle/orcad-managed-pairing-repair-failure'

/**
 * Liveness keeps reconnecting a running host whose connect failed, so a call that met the failure
 * reads as "not reachable yet" and retries instead of dead-ending its pane. Final: a deferred update,
 * unsupported distro or identity/pairing refusal (they wait on the user) and a no-boot refusal (E9).
 */
export function retryableConnectFailure(distro: string, error: unknown): unknown {
  if (
    error instanceof WslOrcadLaunchDeferredError ||
    error instanceof OrcadHostUnsupportedError ||
    error instanceof WslDistroNotRunningError ||
    // A foreign or unpaired server, or a failed re-pair, needs the user (as on the SSH tunnel path);
    // retrying would run a full deploy per pane until the deadline.
    error instanceof OrcadManagedIdentityError ||
    error instanceof OrcadManagedPairingRejectedError ||
    error instanceof OrcadManagedPairingRepairFailedError
  ) {
    return error
  }
  return notReachableYet(distro, errorMessage(error))
}

/** Liveness is still deciding whether the distro stopped: a pane attaching now retries, never boots. */
export function settlingConnectFailure(distro: string): RemoteRuntimeClientError {
  return notReachableYet(distro, 'it is still settling after its server exited')
}

function notReachableYet(distro: string, reason: string): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'remote_runtime_unavailable',
    // Why this wording: subscriptions cross IPC as a message, and renderers match this phrase.
    `Could not connect to the remote Orca runtime in ${distro} yet: ${reason}`
  )
}

/** A `.catch` handler that rethrows a connect failure in its retryable-or-final form. */
export function rethrowRetryable(distro: string): (error: unknown) => never {
  return (error) => {
    throw retryableConnectFailure(distro, error)
  }
}
