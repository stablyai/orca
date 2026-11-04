import type { QueuedMessageOwed } from '../../native-chat/agent-session-journal/queued-message-consume-error'
import type { OrchestrationDb } from './db'
import type { StructuredMailSendRow } from './db/messages/structured-mail-send-store'
import type { StructuredPointerSendOutcome } from './structured-mailbox-pointer-host-contract'

export type StructuredMailAdmitStep = 'next' | 'park' | 'held'

/** What one admission did to its reservation. Held mail is released unread so a later pass can see it. */
export function settleStructuredMailAdmit(input: {
  db: OrchestrationDb
  attempt: StructuredMailSendRow
  outcome: StructuredPointerSendOutcome
  owed: QueuedMessageOwed
  whole: boolean
  held: { held: boolean }
}): StructuredMailAdmitStep {
  const { db, attempt, outcome } = input
  switch (outcome.kind) {
    case 'unattached':
    case 'refused':
      // Refused before admission (a full queue, a detached chat): retry on the session's next edge.
      db.releaseStructuredMailSend(attempt)
      return 'park'
    case 'obsolete':
      db.releaseStructuredMailSend(attempt)
      return input.owed === 'unavailable' ? 'park' : 'next'
    case 'held':
      // Unread and undelivered again: the person's send or Resume redrives it.
      db.releaseStructuredMailSend(attempt)
      input.held.held = true
      return 'held'
    case 'queued':
      return 'next'
    case 'sent':
      // In doubt, including a resend the host answered from an earlier admission: never again.
      if (outcome.state === 'accepted' || outcome.state === 'unknown') {
        db.retireStructuredMailSend(attempt, outcome.state === 'accepted' && input.whole)
      }
      // Pending or rejected: the record decides on a later pass.
      return 'next'
  }
}
