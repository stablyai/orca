// The one registration path for the daemon's listener arrays: push, and hand back a disposer
// that removes exactly that entry. Why the guard: these disposers get called twice (dispose,
// then the caller's own cleanup) and an unguarded splice(-1, 1) would drop the last listener
// rather than none. The only site that does not use this is DegradedDaemonPtyProvider.onReplay,
// which needs a once-only latch over a downstream fan-out as well; see the comment there.
export function addRemovableListener<T>(listeners: T[], listener: NoInfer<T>): () => void {
  listeners.push(listener)
  return () => {
    const index = listeners.indexOf(listener)
    if (index !== -1) {
      listeners.splice(index, 1)
    }
  }
}
