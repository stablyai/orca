import type { DaemonTransientFact } from '../protocol/daemon-stream-events'
import type { DaemonStreamDataBatcher } from '../transport/stream/daemon-stream-data-batcher'
import type { DaemonSessionAttachments } from './daemon-session-attachments'

/** A fact reaches only the client attached to its session; with none attached, it is dropped. */
export function sendDaemonTransientFact(
  attachments: DaemonSessionAttachments,
  batcher: DaemonStreamDataBatcher,
  sessionId: string,
  fact: DaemonTransientFact
): void {
  const clientId = attachments.clientIdForSession(sessionId)
  if (clientId) {
    batcher.enqueueControlEvent(clientId, sessionId, {
      type: 'event',
      event: 'transientFact',
      sessionId,
      payload: fact
    })
  }
}
