// One native capturePage per target at a time, shared by Draw's page readback and the paint lease's
// visibility-restore capture, so neither submits while the other is still pending.
/** Anything that submits native page captures: a guest or a renderer's webContents. */
export type NativeCaptureTarget = { capturePage: (...args: never[]) => Promise<unknown> }
type Lane = { waiters: Set<() => void> }
const lanes = new WeakMap<NativeCaptureTarget, Lane>()

export function isNativeCaptureBusy(target: NativeCaptureTarget): boolean {
  return lanes.has(target)
}

/** Records `capture` as the target's native capture until it settles, then wakes every waiter. */
export function occupyNativeCaptureLane(
  target: NativeCaptureTarget,
  capture: Promise<unknown>
): void {
  const lane: Lane = { waiters: new Set() }
  lanes.set(target, lane)
  const free = (): void => {
    if (lanes.get(target) === lane) {
      lanes.delete(target)
    }
    const waiters = [...lane.waiters]
    lane.waiters.clear()
    for (const waiter of waiters) {
      waiter()
    }
  }
  void capture.then(free, free)
}

/**
 * Calls `onFree` once the target's in-flight capture settles (at once when none is pending).
 * The returned canceller removes the registration, so waits that give up leave nothing attached.
 */
export function whenNativeCaptureLaneFree(
  target: NativeCaptureTarget,
  onFree: () => void
): () => void {
  const lane = lanes.get(target)
  if (!lane) {
    onFree()
    return () => {}
  }
  lane.waiters.add(onFree)
  return () => {
    lane.waiters.delete(onFree)
  }
}
