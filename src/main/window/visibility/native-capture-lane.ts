// One native capturePage per target at a time, shared by Draw's page readback and the paint lease's
// visibility-restore capture, so neither submits while the other is still pending.
const inFlight = new WeakMap<object, Promise<void>>()

/** Settles when the target's in-flight native capture does; undefined when none is pending. */
export function pendingNativeCapture(target: object): Promise<void> | undefined {
  return inFlight.get(target)
}

/** Records `capture` as the target's native capture until it settles. */
export function occupyNativeCaptureLane(target: object, capture: Promise<unknown>): void {
  const settled = capture.then(
    () => {},
    () => {}
  )
  inFlight.set(target, settled)
  void settled.then(() => {
    if (inFlight.get(target) === settled) {
      inFlight.delete(target)
    }
  })
}
