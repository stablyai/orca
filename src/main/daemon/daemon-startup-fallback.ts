let startupFellBack = false

/** Startup could not install a daemon provider, so this launch's terminals run in-process. */
export function noteDaemonStartupFallback(): void {
  startupFellBack = true
}

export function didDaemonStartupFallBack(): boolean {
  return startupFellBack
}
