import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { getPreflightWslTarget, type PreflightRuntimeContext } from './preflight-runtime-target'

export async function hydrateShellPathForAgentDetection(
  context?: PreflightRuntimeContext,
  force = false
): Promise<void> {
  if (getPreflightWslTarget(context)) {
    return
  }
  // Daemon/SSH PATH may omit agents available in the user's shell.
  const hydration = await (force ? hydrateShellPath({ force: true }) : hydrateShellPath())
  if (hydration.ok) {
    mergePathSegments(hydration.segments)
  }
}
