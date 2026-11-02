import type { TerminalDocumentScope } from './document-scope'

// Track pending frames per mount so disposal cancels them; generation guards alone still let stale callbacks run.
export function scheduleDocumentFrame(
  scope: TerminalDocumentScope,
  callback: FrameRequestCallback
) {
  // Engine disposal can schedule callbacks after cancellation; refuse new frames and return a non-live id.
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

export function cancelDocumentFrame(scope: TerminalDocumentScope, id: number) {
  cancelAnimationFrame(id)
  const at = scope.scheduledFrames.indexOf(id)
  if (at !== -1) {
    scope.scheduledFrames.splice(at, 1)
  }
}

export function cancelDocumentFrames(scope: TerminalDocumentScope) {
  scope.framesStopped = true
  for (const id of scope.scheduledFrames) {
    cancelAnimationFrame(id)
  }
  scope.scheduledFrames = []
}
