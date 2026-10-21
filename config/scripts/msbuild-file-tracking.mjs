// FileTracker's long-path-unsafe .tlog files serve incremental builds; these rebuilds are forced.
export function disableMsbuildFileTrackingOnWindows(
  env = process.env,
  platform = process.platform
) {
  // Windows environment keys are case-insensitive, including caller overrides in copied objects.
  if (
    platform === 'win32' &&
    !Object.keys(env).some((key) => key.toLowerCase() === 'trackfileaccess')
  ) {
    env.TrackFileAccess = 'false'
  }
  return env
}
