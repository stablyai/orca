import type Database from '../../sqlite/sync-database'
import type { JournalSqlDatabase } from '../../native-chat/agent-session-journal/database/journal-sql-database'
import {
  readDuePRPendingActions,
  nextPRPendingActionAt,
  deferPRPendingAction,
  type PRPendingActionRow
} from './pr-pending-actions'
import {
  activeSavedPRWatches,
  retireInactiveCurrentPRHeads,
  settlePRPendingObligations,
  recordPRHeadObservation
} from './pr-head-evaluation'
import {
  readPRPendingHeads,
  readOldestPRPendingDelivery,
  hasPRPendingDelivery,
  readPRPendingDeliveryChatIds,
  markPRDeliveryDelivered,
  endPRWatchState,
  deletePRMovedHeads,
  deletePRPendingHead
} from './pr-check-event-tables'
import { deletePRWatchChats, readPRWatchChatIds, readPRChatActions } from './pr-watch-tables'
import { pullRequestKey } from '../../../shared/native-chat/native-chat-pull-request-event'
import type { PRVerifiedAction } from './pr-pending-action-types'

export type PRWatchRead =
  | { kind: 'due'; now: number; limit: number; running: string[] }
  | { kind: 'next'; after: number }
  | { kind: 'heads'; prKey: string }
  | { kind: 'oldest-delivery'; chatId: string }
  | { kind: 'has-delivery'; chatId: string }
  | { kind: 'owed-chats' }
  | { kind: 'watch-chats' }

export type PRWatchReadValues = {
  due: PRPendingActionRow[]
  next: number | null
  heads: ReturnType<typeof readPRPendingHeads>
  'oldest-delivery': ReturnType<typeof readOldestPRPendingDelivery>
  'has-delivery': boolean
  'owed-chats': string[]
  'watch-chats': string[]
}

export type PRWatchEffect =
  | { kind: 'active'; now: number; windowMs: number }
  | { kind: 'retire'; now: number; windowMs: number; held: string[] }
  | { kind: 'settle'; row: PRPendingActionRow; indices: number[]; verified: PRVerifiedAction[] }
  | { kind: 'head'; read: Parameters<typeof recordPRHeadObservation>[1] }
  | { kind: 'defer'; row: PRPendingActionRow; nextAt: number }
  | { kind: 'delivered'; chatId: string; eventId: number; itemId: string }
  | { kind: 'end'; prKey: string }
  | { kind: 'delete-moved'; prKey: string }
  | { kind: 'delete-head'; prKey: string; headSha: string }
  | { kind: 'delete-chats'; chatIds: string[] }

export type PRWatchEffectValues = {
  active: ReturnType<typeof activeSavedPRWatches>
  retire: void
  settle: void
  head: ReturnType<typeof recordPRHeadObservation>
  defer: void
  delivered: void
  end: void
  'delete-moved': void
  'delete-head': void
  'delete-chats': string[]
}

/** The host can name watch operations; SQL and transaction ownership stay on their workers. */
export type PRWatchStorage = {
  readonly readOnly: boolean
  readonly isClosed: boolean
  read<O extends PRWatchRead>(operation: O): Promise<PRWatchReadValues[O['kind']]>
  write<O extends PRWatchEffect>(operation: O): Promise<PRWatchEffectValues[O['kind']]>
}

export function prWatchStorage(database: JournalSqlDatabase): PRWatchStorage {
  return {
    get readOnly() {
      return database.readOnly
    },
    get isClosed() {
      return database.isClosed
    },
    async read<O extends PRWatchRead>(operation: O): Promise<PRWatchReadValues[O['kind']]> {
      const result = await database.readers.database({ kind: 'pr-watch', operation })
      if (result.kind !== 'pr-watch') {
        throw new Error('missing PR-watch read result')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker evaluates exactly this named operation.
      return result.value as PRWatchReadValues[O['kind']]
    },
    async write<O extends PRWatchEffect>(operation: O): Promise<PRWatchEffectValues[O['kind']]> {
      const [result] = await database.effects([{ kind: 'pr-watch', operation }])
      if (!result || typeof result !== 'object' || !('prWatch' in result)) {
        throw new Error('missing PR-watch effect acknowledgement')
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the acknowledged effect evaluates exactly this named operation.
      return result.prWatch as PRWatchEffectValues[O['kind']]
    }
  }
}

export function readPRWatchStorage(
  db: Database.Database,
  operation: PRWatchRead
): PRWatchReadValues[PRWatchRead['kind']] {
  switch (operation.kind) {
    case 'due':
      return readDuePRPendingActions(db, operation.now, operation.limit, operation.running)
    case 'next':
      return nextPRPendingActionAt(db, operation.after)
    case 'heads':
      return readPRPendingHeads(db, operation.prKey)
    case 'oldest-delivery':
      return readOldestPRPendingDelivery(db, operation.chatId)
    case 'has-delivery':
      return hasPRPendingDelivery(db, operation.chatId)
    case 'owed-chats':
      return readPRPendingDeliveryChatIds(db)
    case 'watch-chats':
      return readPRWatchChatIds(db)
  }
}

/** Called inside the existing writer transaction; the wrappers join it without another BEGIN. */
export function applyPRWatchStorage(
  db: Database.Database,
  operation: PRWatchEffect
): PRWatchEffectValues[PRWatchEffect['kind']] {
  if (!db.isTransaction) {
    throw new Error('PR-watch effect requires its writer transaction')
  }
  switch (operation.kind) {
    case 'active':
      return activeSavedPRWatches(db, operation.now, operation.windowMs)
    case 'retire':
      return retireInactiveCurrentPRHeads(db, operation.now, operation.windowMs, operation.held)
    case 'settle':
      return settlePRPendingObligations(db, operation.row, operation.indices, operation.verified)
    case 'head':
      return recordPRHeadObservation(db, operation.read)
    case 'defer':
      return deferPRPendingAction(db, operation.row, operation.nextAt)
    case 'delivered':
      return markPRDeliveryDelivered(db, operation.chatId, operation.eventId, operation.itemId)
    case 'end':
      return endPRWatchState(db, operation.prKey)
    case 'delete-moved':
      return deletePRMovedHeads(db, operation.prKey)
    case 'delete-head':
      return deletePRPendingHead(db, operation.prKey, operation.headSha)
    case 'delete-chats':
      deletePRWatchChats(db, operation.chatIds)
      return [...new Set(readPRChatActions(db).map((action) => pullRequestKey(action)))]
  }
}
