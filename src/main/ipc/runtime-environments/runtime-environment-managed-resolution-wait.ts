import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import {
  resolveManagedRuntimeEnvironment,
  type ManagedRuntimeCallPreparation
} from './runtime-environment-managed-tunnel'

/** One request's wait for a managed host's resolution: its signal detaches only this request,
 *  so its queue slot and payload are released while the resolution goes on for its other waiters. */
export function resolveManagedEnvironmentFor(
  userDataPath: string,
  selector: string,
  preparation: ManagedRuntimeCallPreparation | undefined,
  signal: AbortSignal | undefined
): ReturnType<typeof resolveManagedRuntimeEnvironment> {
  throwIfSignalAborted(signal)
  return waitForPromiseWithSignal(
    resolveManagedRuntimeEnvironment(userDataPath, selector, preparation),
    signal
  )
}
