import { parseWslUncPath } from '../../../src/shared/wsl-paths'

/**
 * The detection target for a workspace that does not exist yet, derived from the repo it will be
 * created from. A Windows host answers from its own PATH unless the request names a distro, so a
 * repo under `\\wsl.localhost\<distro>` would list the agents of the wrong machine.
 */
export function getWorkspaceDetectAgentsParams(
  repoPath?: string | null
): { wslDistro: string } | undefined {
  const distro = repoPath ? parseWslUncPath(repoPath)?.distro : null
  return distro ? { wslDistro: distro } : undefined
}
