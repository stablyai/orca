import { pullRequestKey } from '../../../shared/native-chat/native-chat-pull-request-event'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database'
import { evaluatePRCheckOccurrence } from './pr-check-occurrence'
import {
  deletePRPendingHead,
  insertPRCheckEvent,
  markPRPendingHeadsMoved,
  prunePRCheckContexts,
  readPRCheckContexts,
  replacePRCheckContexts,
  upsertPRPendingHead
} from './pr-check-event-tables'
import { insertPRChatAction, type PRChatAction } from './pr-watch-tables'

/** How long a head the PR moved off keeps being read for its result. */
export const MOVED_HEAD_TTL_MS = 2 * 60 * 60_000

/** A verified action; its head is kept so a push superseded before the next read still reports. */
export function recordPRChatAction(database: JournalHostDatabase, action: PRChatAction): void {
  database.transaction((db) => {
    insertPRChatAction(db, action)
    if (action.headSha) {
      upsertPRPendingHead(db, {
        prKey: pullRequestKey(action),
        headSha: action.headSha,
        now: action.observedAt,
        movedAt: null,
        ttlMs: MOVED_HEAD_TTL_MS
      })
    }
  })
}

/**
 * Applies one complete read of a head. Its context memory, pending-head row, any new event and that
 * event's deliveries commit together, so a crash neither loses a line nor writes one twice.
 */
export function recordPRHeadObservation(
  database: JournalHostDatabase,
  read: {
    prKey: string
    headSha: string
    rollup: readonly unknown[]
    isCurrentHead: boolean
    observedAt: number
  }
): { final: boolean; chatIds: string[] } {
  const { prKey, headSha, isCurrentHead, observedAt } = read
  return database.transaction((db) => {
    if (isCurrentHead) {
      markPRPendingHeadsMoved(db, prKey, headSha, observedAt, MOVED_HEAD_TTL_MS)
    }
    const evaluation = evaluatePRCheckOccurrence(
      read.rollup,
      true,
      readPRCheckContexts(db, prKey, headSha)
    )
    // A finished earlier head needs no memory; the current head keeps it to dedupe later reads.
    replacePRCheckContexts(
      db,
      prKey,
      headSha,
      evaluation.final && !isCurrentHead ? [] : evaluation.contexts
    )
    if (evaluation.final) {
      deletePRPendingHead(db, prKey, headSha)
    } else if (isCurrentHead) {
      upsertPRPendingHead(db, {
        prKey,
        headSha,
        now: observedAt,
        movedAt: null,
        ttlMs: MOVED_HEAD_TTL_MS
      })
    }
    if (isCurrentHead) {
      prunePRCheckContexts(db, prKey, headSha)
    }
    const chatIds = evaluation.verdict
      ? insertPRCheckEvent(db, {
          prKey,
          headSha,
          verdict: evaluation.verdict,
          observedAt,
          isCurrentHead
        }).chatIds
      : []
    return { final: evaluation.final, chatIds }
  })
}
