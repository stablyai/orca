import { isOrcaSessionId } from '../../../../shared/orca-session-address'
import type { OrchestrationDb } from '../db/orchestration-db'
import { canonicalOrcaSessionId } from '../addressing/session-lineage/canonical-orca-session-id'
import { SessionLinkStore } from './session-link-store'

export function pauseSessionLinkForSession(
  db: OrchestrationDb | null | undefined,
  sessionId: string
): void {
  if (!db || !isOrcaSessionId(sessionId)) {
    return
  }
  try {
    const store = new SessionLinkStore(db)
    const link = store.forSession(canonicalOrcaSessionId(sessionId))
    if (link) {
      store.pause(link.id, 'participant-changed')
    }
  } catch (error) {
    console.warn('[session-link] pause unavailable', error)
  }
}
