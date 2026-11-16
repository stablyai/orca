import { pullRequestKey } from '../../../shared/native-chat/native-chat-pull-request-event'
import { evaluatePRCheckOccurrence } from './pr-check-occurrence'
import {
  deleteInactiveCurrentPRHeads,
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
import { markPRPendingObligationsDone, type PRPendingActionRow } from './pr-pending-actions'
import type Database from '../../sqlite/sync-database'

/** How long a head the PR moved off keeps being read for its result. */
export const MOVED_HEAD_TTL_MS = 2 * 60 * 60_000

/** Each PR's newest action, for the PRs a recent action keeps watched. */
export function recentPRChatActions(
  db: Database.Database,
  now: number,
  windowMs: number
): Map<string, PRChatAction> {
  const newest = new Map<string, PRChatAction>()
  for (const action of readPRChatActions(db)) {
    newest.set(pullRequestKey(action), action)
  }
  for (const [prKey, action] of newest) {
    if (action.observedAt + windowMs <= now) {
      newest.delete(prKey)
    }
  }
  return newest
}

/** Startup: the recent actions to watch, after dropping moved heads past their deadline. */
export function activeSavedPRWatches(
  db: Database.Database,
  now: number,
  windowMs: number
): Map<string, PRChatAction> {
  requireTransaction(db)
  deleteExpiredPRPendingHeads(db, now)
  return recentPRChatActions(db, now, windowMs)
}

/** Retires current heads no recent action and no live watch holds, both read in the same
 *  transaction as the delete, so an action saved while startup was waiting keeps its head. */
export function retireInactiveCurrentPRHeads(
  db: Database.Database,
  now: number,
  windowMs: number,
  watchedPRKeys: Iterable<string>
): void {
  requireTransaction(db)
  {
    const held = new Set([...recentPRChatActions(db, now, windowMs).keys(), ...watchedPRKeys])
    deleteInactiveCurrentPRHeads(db, held)
  }
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
  db: Database.Database,
  action: PRChatAction,
  movedAt: number | null = null
): void {
  requireTransaction(db)
  insertActionWithHead(db, action, movedAt)
}

/** Decided obligations: their verified actions and their progress in the row commit together. */
export function settlePRPendingObligations(
  db: Database.Database,
  row: PRPendingActionRow,
  indices: readonly number[],
  verified: readonly { action: PRChatAction; movedAt: number | null }[]
): void {
  requireTransaction(db)
  {
    for (const { action, movedAt } of verified) {
      insertActionWithHead(db, action, movedAt)
    }
    markPRPendingObligationsDone(db, row, indices)
  }
}

/**
 * Applies one complete read of a head. Its context memory, pending-head row, any new event and that
 * event's deliveries commit together, so a crash neither loses a line nor writes one twice.
 */
export function recordPRHeadObservation(
  db: Database.Database,
  read: {
    prKey: string
    headSha: string
    rollup: readonly unknown[]
    isCurrentHead: boolean
    observedAt: number
  }
): { final: boolean; chatIds: string[] } {
  const { prKey, headSha, isCurrentHead, observedAt } = read
  requireTransaction(db)
  {
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
  }
}

function requireTransaction(db: Database.Database): void {
  if (!db.isTransaction) {
    throw new Error('PR-watch state requires its writer transaction')
  }
}
