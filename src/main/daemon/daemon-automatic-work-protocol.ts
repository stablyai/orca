import { DAEMON_ENDPOINT_LOST_MESSAGE } from './daemon-endpoint-ownership'
import type { DaemonAutomaticWorkGuard } from './daemon-automatic-work-guard'

// Handle before session routing; older daemons reject these request types as unknown.
export type AutomaticWorkRequestType = 'automaticWorkStatus' | 'resumeAutomaticWork'

export function automaticWorkRequestType(request: {
  type: string
}): AutomaticWorkRequestType | null {
  return request.type === 'automaticWorkStatus' || request.type === 'resumeAutomaticWork'
    ? request.type
    : null
}

// Recheck endpoint ownership on resume so a replaced daemon cannot rewrite its successor's marker.
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
