import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { getPreflightWslTarget, type PreflightRuntimeContext } from './preflight-runtime-target'

export async function hydrateShellPathForAgentDetection(
  context?: PreflightRuntimeContext,
  force = false
): Promise<void> {
  if (getPreflightWslTarget(context)) {
    return
  }
  // Why: remote runtime servers may inherit a sparse daemon/SSH PATH even
  // though the user's shell can run the agents.
  const hydration = await (force ? hydrateShellPath({ force: true }) : hydrateShellPath())
  if (hydration.ok) {
    mergePathSegments(hydration.segments)
  }
}
