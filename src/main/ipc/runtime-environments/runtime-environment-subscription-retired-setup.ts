import { remoteRuntimeUnavailableError } from '../../../shared/remote-runtime/requests/remote-runtime-request-frames'

/**
 * A subscription still being set up when its environment's transport is retired (a Restart, Wake or
 * re-pair invalidates it on purpose) is aborted. That abort is ours, not a failure: answer with the
 * recoverable "closed before it started" so the window resubscribes on the new transport instead of
 * showing "This operation was aborted" and giving the pane up (RESTART-ABORT-BANNER).
 */
export function retiredSetupError(error: unknown, transportCurrent: boolean): unknown {
  return !transportCurrent && error instanceof Error && error.name === 'AbortError'
    ? remoteRuntimeUnavailableError('Remote runtime subscription closed before it started.')
    : error
}
