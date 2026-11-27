import {
  hydrateShellPath,
  mergePathSegments
} from '../../startup/shell-environment/hydrate-shell-path'
import {
  getPreflightWslTarget,
  type PreflightRuntimeContext
} from '../preflight/preflight-runtime-target'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../shared/concurrency/abort-signal-reason'

export async function hydrateShellPathForAgentDetection(
  context?: PreflightRuntimeContext,
  force = false,
  signal?: AbortSignal
): Promise<void> {
  if (getPreflightWslTarget(context)) {
    return
  }
  // Daemon/SSH PATH may omit agents available in the user's shell.
  throwIfSignalAborted(signal)
  const hydration = await waitForPromiseWithSignal(
    force ? hydrateShellPath({ force: true }) : hydrateShellPath(),
    signal
  )
  throwIfSignalAborted(signal)
  if (hydration.ok) {
    mergePathSegments(hydration.segments)
  }
}
