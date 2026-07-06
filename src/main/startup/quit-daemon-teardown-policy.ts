export function shouldShutdownDaemonForQuit(options: {
  isDevParentShutdownRequested: boolean
  isQuittingForUpdate: boolean
}): boolean {
  // Why: update quits must preserve daemon-backed PTYs for warm reattach after
  // relaunch; only ownerless dev profiles should tear the daemon down here.
  return options.isDevParentShutdownRequested
}
