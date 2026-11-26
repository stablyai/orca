let supervisedStopRequested = false
let supervisedStop = new AbortController()
let supervisedSpawnGate: (() => Promise<boolean>) | null = null
let supervisedSpawnHeld: (() => boolean) | null = null

/** A stop that reached `--supervise` before its child existed must still reach that child. */
export function requestSupervisedServeStop(): void {
  supervisedStopRequested = true
  supervisedStop.abort()
}

/** Starts a supervised run: `gate` resolves true when a replacement may spawn, false on stop. */
export function resetSupervisedServeStop(
  gate: (() => Promise<boolean>) | null = null,
  held: (() => boolean) | null = null
): void {
  supervisedStopRequested = false
  supervisedStop = new AbortController()
  supervisedSpawnGate = gate
  supervisedSpawnHeld = held
}

/** Checked synchronously right before a first spawn: a desktop install may have begun since. */
export function isSupervisedSpawnHeld(): boolean {
  return supervisedStopRequested || (supervisedSpawnHeld?.() ?? false)
}

/** Update-loop replacements must honor the same install hold. */
export async function mayRespawn(): Promise<boolean> {
  if (supervisedStopRequested) {
    return false
  }
  return supervisedSpawnGate ? supervisedSpawnGate() : true
}

export function supervisedStopSignal(): AbortSignal {
  return supervisedStop.signal
}

type ServeChild = { pid: number | null; stop: () => void }
let currentChild: ServeChild | null = null

export function currentServeChild(): ServeChild | null {
  return currentChild
}

/** A stop that reached `--supervise` before this child existed is passed on to it now. */
export function trackServeChild(child: ServeChild): void {
  currentChild = child
  if (supervisedStopRequested) {
    child.stop()
  }
}

export function untrackServeChild(child: ServeChild): void {
  if (currentChild === child) {
    currentChild = null
  }
}
