import type { GpuFallbackRestartDecision } from './gpu-fallback-restart-prompt'

/**
 * Orders the steps that engage Windows safe-graphics mode.
 *
 * Why the marker is persisted BEFORE the prompt: Chromium terminates the whole
 * browser process with a fatal CHECK ("GPU process isn't usable. Goodbye." ->
 * STATUS_BREAKPOINT / 0x80000003) on the 6th GPU-process failure. Orca engages
 * on the 3rd, so the modal restart prompt is racing a hard kill that lands ~2.5s
 * later when the GPU crashes, and ~7ms later when it cannot launch at all.
 * Persisting after the click meant an unattended machine never latched the
 * fallback and crash-looped on every subsequent launch.
 *
 * The marker is therefore written without consent, so callers must drop it again
 * on an orderly shutdown — see `shouldKeepProvisionalGpuFallbackMarker`.
 */
export type GpuFallbackEngagementDeps = {
  /** Must be synchronous — an async write would miss the kill window entirely. */
  persistMarker: () => void
  /** Returns false when the marker could not be removed. */
  clearMarker: () => boolean
  prompt: () => Promise<GpuFallbackRestartDecision>
  isQuitting: () => boolean
  onMarkerPersistFailed: (error: unknown) => void
  onMarkerClearFailed: () => void
  onPromptFailed: (error: unknown) => void
  onRestartDeferred: () => void
}

export type GpuFallbackEngagementOutcome =
  /** Marker is on disk and the user asked to restart now. */
  | 'restart'
  /** User confirmed, but a quit is already running it down; keep the marker, skip the relaunch. */
  | 'confirmed-quitting'
  /** User chose to keep running; marker cleared, next launch keeps hardware GPU. */
  | 'deferred'
  /** User declined but the marker is still on disk; the caller must keep retrying. */
  | 'deferred-uncleared'
  /** Marker is on disk but unconfirmed; only an abnormal death should keep it. */
  | 'latched'
  /** Marker could not be persisted, so neither answer could be honored. */
  | 'marker-failed'

/**
 * Whether the caller must keep retrying the marker delete on shutdown.
 *
 * Pure so the mapping is testable: `latched` never got an answer, and
 * `deferred-uncleared` got a decline the delete could not honor.
 */
export function shouldKeepProvisionalGpuFallbackMarker(
  outcome: GpuFallbackEngagementOutcome
): boolean {
  return outcome === 'latched' || outcome === 'deferred-uncleared'
}

export async function engageGpuFallback(
  deps: GpuFallbackEngagementDeps
): Promise<GpuFallbackEngagementOutcome> {
  try {
    // `() => void` structurally accepts an async function, whose write would land
    // after the kill window and whose rejection would escape this catch.
    const persisted = deps.persistMarker() as unknown
    if (isThenable(persisted)) {
      void (persisted as PromiseLike<void>).then?.(
        () => undefined,
        () => undefined
      )
      throw new TypeError('persistMarker must be synchronous')
    }
  } catch (error) {
    // Without a durable marker a relaunch returns to the same broken GPU.
    deps.onMarkerPersistFailed(error)
    return 'marker-failed'
  }

  let decision: GpuFallbackRestartDecision
  try {
    decision = await deps.prompt()
  } catch (error) {
    deps.onPromptFailed(error)
    return 'latched'
  }

  // The decision is honored before `isQuitting`: a tray/OS quit resolves the
  // parented dialog, and dropping the answer there would ignore explicit consent.
  if (decision !== 'restart') {
    const cleared = deps.clearMarker()
    if (!cleared) {
      deps.onMarkerClearFailed()
    }
    deps.onRestartDeferred()
    return cleared ? 'deferred' : 'deferred-uncleared'
  }
  return deps.isQuitting() ? 'confirmed-quitting' : 'restart'
}

function isThenable(value: unknown): boolean {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function'
}
