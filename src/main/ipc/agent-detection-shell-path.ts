import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'
import { getPreflightWslTarget, type PreflightRuntimeContext } from './preflight-runtime-target'

export async function hydrateShellPathForAgentDetection(
  context?: PreflightRuntimeContext
): Promise<void> {
  if (getPreflightWslTarget(context)) {
    return
  }
  // Why: remote runtime servers may inherit a sparse daemon/SSH PATH even
  // though the user's shell can run the agents.
  const hydration = await hydrateShellPath()
  if (hydration.ok) {
    mergePathSegments(hydration.segments)
  }
}
