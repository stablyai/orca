// An orcad's browser engine is an Orca app it starts without pairing; orcad is the caller on its socket.
let launchedAsBrowserEngineSidecar = false

export function markBrowserEngineSidecarLaunch(): void {
  launchedAsBrowserEngineSidecar = true
}

/** True in an orcad's browser engine, whose runtime calls come from that orcad, not from agents. */
export function isBrowserEngineSidecarLaunch(): boolean {
  return launchedAsBrowserEngineSidecar
}
