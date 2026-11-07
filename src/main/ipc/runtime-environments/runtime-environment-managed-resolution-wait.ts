import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'

/** One request's wait for a managed host's preparation: its signal detaches only this request, so
 *  its queue slot and payload are released while the preparation goes on for its other waiters. */
export function waitForManagedPreparation<T>(
  prepare: () => Promise<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  throwIfSignalAborted(signal)
  return waitForPromiseWithSignal(prepare(), signal)
}
