import type { StructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { createKeyedTrailingEdgeCoalescer } from '../../../client/events/keyed-trailing-edge-coalescer'
import type { JournalPublication } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-conversations'

/** Coalesce streaming batches until quiet; settled turns stop emitting, so the final nudge still lands promptly. */
const REDRIVE_FLUSH_MS = 300

/** A turn that streams without pause still gets re-evaluated this often. */
const REDRIVE_MAX_WAIT_MS = 2_000

/** Any journal batch can carry a tombstoned turn settlement or freed queue room; coalesce parked-mail
 * passes, which re-read what they need, so batches may combine safely. Fresh mail still uses deliverForHandle immediately. */
export function subscribeForRedrive(
  host: StructuredAgentSessionHost,
  sessionId: string,
  onJournalActivity: (sessionId: string) => void,
  /** Whether a publication changed anything the subscriber acts on. */
  relevant: (publication: JournalPublication) => boolean
): () => void {
  const coalescer = createKeyedTrailingEdgeCoalescer(onJournalActivity, {
    flushMs: REDRIVE_FLUSH_MS,
    maxWaitMs: REDRIVE_MAX_WAIT_MS
  })
  try {
    let seeded = false
    const unsubscribe = host.observeConversationPublications(sessionId, {
      next: (publication) => {
        const changed = relevant(publication)
        if (seeded && changed) {
          coalescer.schedule(sessionId)
        }
        seeded = true
      },
      error: (error) =>
        console.warn('[orchestration] structured session redrive failed', sessionId, error)
    })
    // Discard pending redrive on settlement so it cannot nudge a session no dispatch owns.
    return () => {
      coalescer.dispose()
      unsubscribe()
    }
  } catch (error) {
    console.warn('[orchestration] structured session redrive subscription failed', sessionId, error)
    coalescer.dispose()
    return () => {}
  }
}
