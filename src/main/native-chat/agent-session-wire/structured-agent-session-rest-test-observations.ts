// What a rest rig's run observed: how often each chat's journal opened, and the status rows its
// stream carried.

import type { RestTestRig } from './structured-agent-session-rest-test-rig'

export function restTestOpens(rig: RestTestRig, sessionId: string): number {
  return rig.adapter.historyFilePath.mock.calls.filter(([id]) => id === sessionId).length
}

/** The newest row the status stream carried for a session. */
export function latestRestTestStatus(rig: RestTestRig, sessionId: string) {
  for (const event of rig.statusEvents.toReversed()) {
    if (event.type === 'status' && event.session.sessionId === sessionId) {
      return event.session
    }
    if (event.type === 'snapshot') {
      const found = event.sessions.find((session) => session.sessionId === sessionId)
      if (found) {
        return found
      }
    }
  }
  return undefined
}
