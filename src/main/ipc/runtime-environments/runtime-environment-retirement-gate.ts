import { setRuntimeEnvironmentRetirement } from '../../../shared/runtime-environment-retirement'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { disconnectRuntimeEnvironmentForUser } from '../ssh/ssh-host-user-disconnect'
import { markRuntimeEnvironmentManuallyDisconnected } from './runtime-environment-manual-disconnect'

type RuntimeLayer = Parameters<typeof disconnectRuntimeEnvironmentForUser>[1]

// Retirement rides on the manual-disconnect gate, which every call, subscription and status probe
// already checks and which answers with a quiet `runtime_manually_disconnected` envelope.

/** Its host is gone for good: stop dialing it now and on every later launch. */
export function retireRuntimeEnvironment(environmentId: string, layer: RuntimeLayer): void {
  setRuntimeEnvironmentRetirement(layer.userDataPath, environmentId, new Date().toISOString())
  disconnectRuntimeEnvironmentForUser(environmentId, layer)
}

/** At startup, before anything dials: a retired server stays disconnected across relaunches. */
export function restoreRetiredRuntimeEnvironments(userDataPath: string): void {
  for (const environment of listEnvironments(userDataPath)) {
    if (environment.retiredAt) {
      markRuntimeEnvironmentManuallyDisconnected(environment.id)
    }
  }
}

/** An explicit Connect is the user asking to try it again. */
export function liftRuntimeEnvironmentRetirement(
  userDataPath: string,
  environmentId: string
): void {
  try {
    setRuntimeEnvironmentRetirement(userDataPath, environmentId, null)
  } catch {
    // A sidecar this build cannot read keeps its marker; the connect still proceeds.
  }
}
