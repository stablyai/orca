import type { TerminalDocumentScope } from './document-scope'

/**
 * An animation frame the document can take back (ruling 21).
 *
 * A generation guard makes a stale frame *do* nothing; it still runs, and inside a WebView that
 * is the same thing. On the page it is not: the mount that scheduled the frame may be gone and
 * the next one already up, and a callback that reads the scope reads the new mount's. Every frame
 * the document asks for is registered here so `cancelDocumentFrames` can take the pending ones
 * back, which is what the page's dispose does. The id is dropped as the frame runs, so the list
 * holds only what is still owed.
 */
export function scheduleDocumentFrame(
  scope: TerminalDocumentScope,
  callback: FrameRequestCallback
) {
  // A stopped document asks for nothing. Tearing the terminal down runs the engine's own
  // disposal, which calls back into these modules, and a frame asked for on the way out would be
  // owed by nobody — the cancel has already run. `-1` is not a live frame id, so a caller that
  // holds one and cancels it later is cancelling nothing.
  if (scope.framesStopped) {
    return -1
  }
  const id = requestAnimationFrame(function (time) {
    const at = scope.scheduledFrames.indexOf(id)
    if (at !== -1) {
      scope.scheduledFrames.splice(at, 1)
    }
    callback(time)
  })
  scope.scheduledFrames.push(id)
  return id
}

/** Takes back every frame the document is still owed, and stops it asking for more. */
export function cancelDocumentFrames(scope: TerminalDocumentScope) {
  scope.framesStopped = true
  for (const id of scope.scheduledFrames) {
    cancelAnimationFrame(id)
  }
  scope.scheduledFrames = []
}
