import type { ConnectorReplyCutJournal } from '../connector-cloud/connector-reply-outbox'
import type Database from '../sqlite/sync-database'
import {
  cutJournalConnectorReplies,
  fillEachJournalConnectorReply,
  fillJournalConnectorReplies,
  holdJournalConnectorRepliesForRetry,
  probeJournalConnectorReplyExpiry,
  recutJournalConnectorReplies,
  releaseJournalConnectorClaim,
  sentJournalConnectorReplies
} from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies'
import {
  readJournalConnectorReplies,
  readOwedJournalConnectorReplies
} from '../native-chat/agent-session-journal/connector-replies/journal-connector-replies-read'

// The reply outbox journal over a real journal database, its writes made as the journal's writer
// makes them, each asking its admit as the writer takes it.

export function replyJournalOver(db: Database.Database, now: number): ConnectorReplyCutJournal {
  return {
    read: async (sessionId) => readJournalConnectorReplies(db, sessionId),
    readOwed: async (account, after, limit) =>
      readOwedJournalConnectorReplies(db, account, after, limit),
    // A write asks its admit as the writer takes it, as the journal's lane does.
    fillOutcomes: async (fills, admit) =>
      admit?.() !== false && fillJournalConnectorReplies(db, fills, now) > 0,
    sent: async (keys) => sentJournalConnectorReplies(db, keys, now),
    cut: async (rows, admit) => admit?.() !== false && cutJournalConnectorReplies(db, rows) > 0,
    recut: async (claim, cut, failure, admit) =>
      admit?.() !== false && recutJournalConnectorReplies(db, claim, cut, failure) > 0,
    releaseClaim: async (claim) => releaseJournalConnectorClaim(db, claim) > 0,
    holdForRetry: async (rows, admit) =>
      admit?.() !== false && holdJournalConnectorRepliesForRetry(db, rows) > 0,
    // One transaction, as the writer runs the command: all of it commits, or none.
    fillEach: async (fills, admit) => {
      if (admit?.() === false) {
        return fills.map(() => false)
      }
      db.exec('BEGIN IMMEDIATE')
      try {
        const changed = fillEachJournalConnectorReply(db, fills, now)
        db.exec('COMMIT')
        return changed
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    probeExpired: async (keys) => probeJournalConnectorReplyExpiry(db, keys)
  }
}
