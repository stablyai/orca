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
  deleteExpiredPRPendingHeads,
  upsertPRPendingHead
} from './pr-check-event-tables'
import { insertPRChatAction, readPRChatActions, type PRChatAction } from './pr-watch-tables'
import { deletePRPendingAction, type PRPendingActionRow } from './pr-pending-actions'
import type Database from '../../sqlite/sync-database'

/** How long a head the PR moved off keeps being read for its result. */
export const MOVED_HEAD_TTL_MS = 2 * 60 * 60_000

/** Startup: each PR's newest action, for the PRs a recent action keeps watched, after dropping
 *  moved heads past their deadline. Current heads wait for every reason (`deleteInactiveCurrentPRHeads`). */
export function activeSavedPRWatches(
  database: JournalHostDatabase,
  now: number,
  windowMs: number
): Map<string, PRChatAction> {
  const newest = new Map<string, PRChatAction>()
  for (const action of readPRChatActions(database.db)) {
    newest.set(pullRequestKey(action), action)
  }
  for (const [prKey, action] of newest) {
    if (action.observedAt + windowMs <= now) {
      newest.delete(prKey)
    }
  }
  database.transaction((db) => deleteExpiredPRPendingHeads(db, now))
  return newest
}

function insertActionWithHead(db: Database.Database, action: PRChatAction, movedAt: number | null) {
  insertPRChatAction(db, action)
  if (action.headSha) {
    upsertPRPendingHead(db, {
      prKey: pullRequestKey(action),
      headSha: action.headSha,
      now: action.observedAt,
      movedAt,
      ttlMs: MOVED_HEAD_TTL_MS
    })
  }
}

/** A verified action; its head is kept so a push superseded before the next read still reports.
 *  `movedAt` is set for a head the PR had already moved off when the push was verified. */
export function recordPRChatAction(
  database: JournalHostDatabase,
  action: PRChatAction,
  movedAt: number | null = null
): void {
  database.transaction((db) => insertActionWithHead(db, action, movedAt))
}

/** A pending row's every obligation decided: its verified actions and its deletion commit together. */
export function completePRPendingAction(
  database: JournalHostDatabase,
  row: PRPendingActionRow,
  verified: readonly { action: PRChatAction; movedAt: number | null }[]
): void {
  database.transaction((db) => {
    for (const { action, movedAt } of verified) {
      insertActionWithHead(db, action, movedAt)
    }
    deletePRPendingAction(db, row)
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
    const prior = readPRCheckContexts(db, prKey, headSha)
    const evaluation = evaluatePRCheckOccurrence(read.rollup, true, prior)
    replacePRCheckContexts(db, prKey, headSha, evaluation.contexts)
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
