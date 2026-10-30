import { mailSourceIncarnation } from './db/messages/mail-source-order'
import type { MailStopCapture } from '../../native-chat/agent-session-journal/journal-mail-holds'
import type { OrchestrationDb } from './db'

/** Acquires only its own zero-wait reservation; the receipt releases it after journal COMMIT. */
export function captureSessionMailAtStop(
  db: OrchestrationDb | null,
  retire: (db: OrchestrationDb) => void
): MailStopCapture {
  if (!db || db.db.isTransaction) {
    return {}
  }
  let acquired = false
  let timeout: number | undefined
  const finished = () => {
    let failed = false
    try {
      if (acquired) {
        db.db.exec('ROLLBACK')
        acquired = false
      }
    } catch {
      failed = true
    }
    try {
      if (timeout !== undefined) {
        db.db.pragma(`busy_timeout = ${timeout}`)
      }
    } catch {
      failed = true
    }
    if (failed) {
      try {
        retire(db)
      } catch (error) {
        console.warn('[mail] capture connection retirement failed', error)
      }
    }
  }
  try {
    timeout = Number(db.db.pragma('busy_timeout', { simple: true }))
    if (!Number.isSafeInteger(timeout) || timeout < 0) {
      return {}
    }
    db.db.pragma('busy_timeout = 0')
    db.db.exec('BEGIN IMMEDIATE')
    acquired = true
    const throughSequence = Number(
      db.db.prepare('SELECT COALESCE(MAX(sequence), 0) AS n FROM messages').get()?.n
    )
    const incarnation = mailSourceIncarnation(db.db)
    return {
      cut: {
        incarnation,
        throughSequence
      },
      finished
    }
  } catch {
    finished()
    return {}
  }
}
