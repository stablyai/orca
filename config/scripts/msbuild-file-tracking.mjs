/**
 * Turns off MSBuild's FileTracker for a Windows native rebuild unless the caller set it.
 *
 * Why: FileTracker writes .tlog files under the package's build dir with no long-path
 * support (FTK1011), so a deep worktree path fails the link step. The trackers only feed
 * incremental builds, and every Orca native rebuild is a full one.
 */
export function disableMsbuildFileTrackingOnWindows(
  env = process.env,
  platform = process.platform
) {
  // Why any casing: a copied env object is case-sensitive, but Windows treats `trackfileaccess` as the same variable.
  if (
    platform === 'win32' &&
    !Object.keys(env).some((key) => key.toLowerCase() === 'trackfileaccess')
  ) {
    env.TrackFileAccess = 'false'
  }
  return env
}
