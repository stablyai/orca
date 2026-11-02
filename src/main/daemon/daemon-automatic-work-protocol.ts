import { DAEMON_ENDPOINT_LOST_MESSAGE } from './daemon-endpoint-ownership'
import type { DaemonAutomaticWorkGuard } from './daemon-automatic-work-guard'

// Why request types outside DaemonRequest: the server answers them before the session router, and
// an older daemon rejects them as unknown.
export type AutomaticWorkRequestType = 'automaticWorkStatus' | 'resumeAutomaticWork'

export function automaticWorkRequestType(request: {
  type: string
}): AutomaticWorkRequestType | null {
  return request.type === 'automaticWorkStatus' || request.type === 'resumeAutomaticWork'
    ? request.type
    : null
}

/**
 * Answers an automatic-work request, or undefined for any other request. Why a fresh ownership
 * read for resume: the loss latch trails replacement, and a resume from a replaced daemon would
 * rewrite its successor's run marker.
 */
export function answerAutomaticWorkRequest(
  request: { type: string },
  guard: Pick<DaemonAutomaticWorkGuard, 'handle'>,
  endpoint: { hasLostOwnership(): boolean }
): ReturnType<DaemonAutomaticWorkGuard['handle']> | undefined {
  const type = automaticWorkRequestType(request)
  if (!type) {
    return undefined
  }
  if (type === 'resumeAutomaticWork' && endpoint.hasLostOwnership()) {
    throw new Error(DAEMON_ENDPOINT_LOST_MESSAGE)
  }
  return guard.handle(type)
}
