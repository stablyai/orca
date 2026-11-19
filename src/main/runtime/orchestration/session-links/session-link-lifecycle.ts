import { isOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address'
import type { OrchestrationDb } from '../db/orchestration-db'
import { canonicalOrcaSessionId } from '../addressing/session-lineage/canonical-orca-session-id'
import { sessionLinks } from './worker/session-link-worker-client'

/** Queued behind earlier link calls, so a delivery that starts after it sees the pause. */
export function pauseSessionLinkForSession(
  db: OrchestrationDb | null | undefined,
  sessionId: string
): Promise<void> {
  if (!db || !isOrcaSessionId(sessionId)) {
    return Promise.resolve()
  }
  const links = sessionLinks(db)
  return links
    .forSession(canonicalOrcaSessionId(sessionId))
    .then((link) => (link ? links.pause(link.id, 'participant-changed') : undefined))
    .catch((error) => console.warn('[session-link] pause unavailable', error))
}
