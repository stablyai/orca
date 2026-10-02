// What host startup does with each chat's stored status, before any client lists a tab.
//
// Seed: every settled, listed chat's status row is published from its stored status, so session
// lists have it at paint, without opening the chat. Settle: first every lease a crash left
// `recovering` is resolved (a surviving provider process is stopped and its death recorded), so
// each verdict below is taken once, from that evidence. Then every chat whose stored status shows
// work a gone process left, listed or not, is opened once, one at a time, and its open appends the
// settlement plan. A listed one goes through the restart restore's own per-chat worker and stays
// open; any other is settled and closed, never indexed or published. Chat commands wait for the
// settle (see `StructuredAgentSessionHostDeps.commandsReady`); listing, paint and status reads do
// not. A listed chat with no stored status yet (an older build wrote it last, or a per-chat file is
// not yet copied) is left to the background restore after the listing, which is the same worker.

import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { forEachWithConcurrency } from '../../../shared/map-with-concurrency'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type { StructuredAgentSessionStatusProjection } from '../../../shared/structured-agent-session-projection'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { JournalLoad } from '../agent-session-journal/journal-open'
import {
  deleteJournalSessionStatus,
  isUnsettledJournalSessionStatus,
  readJournalSessionStatuses,
  readUnsettledJournalSessionIds
} from '../agent-session-journal/journal-session-state'
import {
  openStructuredAgentSessionConversationJournal,
  type StructuredAgentSessionConversationOpenDeps
} from './structured-agent-session-conversation-open'
import { hasHistoryOutsideJournalDatabase } from './structured-agent-session-read-restore'
import { deriveMissingStatuses } from './structured-agent-session-startup-status-derive'

// Record-only (a probe and at most a process stop each), so a few at once.
const RECOVERY_CONCURRENCY = 4
// A recovery is process probes around at most one stop (its SIGTERM grace is 5.5 s). Past this a
// probe has stopped answering: the lease stays `recovering`, unverified and never called dead, for
// the next attach or send to resolve, and the settle goes on.
const RECOVERY_BUDGET_MS = 15_000

export type StructuredAgentSessionStartupStateDeps = {
  openDeps: StructuredAgentSessionConversationOpenDeps & {
    store: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords'>
  }
  /** `hostCanSettleRecord` bound to this host's adapter. */
  canSettle: (record: AgentSessionRecord | null) => record is AgentSessionRecord
  seedStatus: (
    record: AgentSessionRecord,
    stored: { projected: StructuredAgentSessionStatusProjection; lastActivityAt: number }
  ) => void
  /** Resolves a `recovering` lease; never throws (a failure is reported and left to the next
   *  attach or send). */
  resolveRecovery: (sessionId: string) => Promise<boolean>
  /** The restart restore's per-chat worker (lease bookkeeping, serialize, open, publish), resolving
   *  recovery through `resolveRecovery`. */
  restoreListed: (
    records: AgentSessionRecord[],
    resolveRecovery: (sessionId: string) => Promise<boolean>
  ) => Promise<void>
  /** Tests shorten it; production takes the default. */
  recoveryBudgetMs?: number
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
  hasSession: (sessionId: string) => boolean
  /** Whether the chat still has its tab. */
  isListed: (sessionId: string) => boolean
  isDisposed: () => boolean
}

export type StructuredAgentSessionStartupState = {
  /** Seeds settled listed chats; answers the listed ids the background restore still opens. */
  seedStoredStatuses: (listedIds: readonly string[]) => string[]
  /** Settles every chat a gone process left with work, once per host. Never rejects. */
  settleOwedSessions: (listedIds: readonly string[]) => Promise<void>
  /** The settle step has started and not finished. */
  isSettling: () => boolean
  /**
   * The one settle of a chat nothing holds open. Call it inside the chat's serialize; it never
   * waits on the startup gate. `loaded`, when the caller holds the chat's current fold, is used in
   * place of a replay. True when it opened and closed the chat, whether or not the chat had work
   * (so a settled chat is opened again). False, opening nothing, when `canSettle` rejects the chat,
   * the chat is already open, or after quit. Rejects when the open or the close throws, so callers
   * must catch.
   */
  settleClosedChat: (record: AgentSessionRecord, loaded?: JournalLoad) => Promise<boolean>
  /**
   * The background pass's first step: each listed chat with history here and no status row gets
   * its row from its rows alone, opening nothing, folded one chat at a time in the order given (the
   * startup step puts the chats on screen first) and written a slice at a time. A row showing work
   * a gone process left is stored but never shown; a corrupt history gets no row, so its open and
   * rebuild run. Answers the chats still to open, which their open settles, rebuilds or gives a
   * row; see `deriveMissingStatuses`.
   */
  deriveMissingStatuses: (sessionIds: readonly string[]) => Promise<string[]>
}

export function createStructuredAgentSessionStartupState(
  deps: StructuredAgentSessionStartupStateDeps
): StructuredAgentSessionStartupState {
  let settling: Promise<void> | null = null
  let settled = false
  return {
    seedStoredStatuses: (listedIds) => seedStoredStatuses(deps, listedIds),
    settleOwedSessions: (listedIds) => {
      settling ??= settleOwedSessions(deps, listedIds).finally(() => {
        settled = true
      })
      return settling
    },
    isSettling: () => settling !== null && !settled,
    settleClosedChat: (record, loaded) => settleClosed(deps, record, loaded),
    deriveMissingStatuses: (sessionIds) => deriveMissingStatuses(deps, sessionIds)
  }
}

function seedStoredStatuses(
  deps: StructuredAgentSessionStartupStateDeps,
  listedIds: readonly string[]
): string[] {
  const database = deps.openDeps.journalDatabase
  // A newer build's database: nothing is stored this build can read, and every chat reads as it does.
  if (database.readOnly) {
    return [...listedIds]
  }
  let stored: ReturnType<typeof readJournalSessionStatuses>
  try {
    stored = readJournalSessionStatuses(database.db, listedIds)
  } catch (error) {
    // Fails open: every listed chat is restored in the background, as before stored status existed.
    deps.openDeps.logger.warn('reading stored chat status failed', {
      scope: 'startup-status-read',
      error
    })
    return [...listedIds]
  }
  const byId = new Map(stored.map((row) => [row.sessionId, row.status]))
  const background: string[] = []
  for (const sessionId of listedIds) {
    const record = deps.openDeps.store.getRecord(sessionId)
    if (!record) {
      // Its record may still be owed by the records import: the restore reads records when it runs.
      background.push(sessionId)
      continue
    }
    if (!deps.canSettle(record)) {
      continue
    }
    if (!byId.has(sessionId)) {
      // Never sent opens nothing; a per-chat file not yet copied is read in the background.
      if (hasHistoryOutsideJournalDatabase(database, record)) {
        background.push(sessionId)
      }
      continue
    }
    const status = byId.get(sessionId)
    if (status && isUnsettledJournalSessionStatus(status)) {
      // The settle's: its open settles and publishes.
      continue
    }
    if (!status || (status.summary.status !== null && status.summary.status !== 'idle')) {
      // No row this build can read: its open writes and publishes one.
      background.push(sessionId)
      continue
    }
    deps.seedStatus(record, { projected: status.summary, lastActivityAt: status.lastActivityAt })
  }
  return background
}

async function settleOwedSessions(
  deps: StructuredAgentSessionStartupStateDeps,
  listedIds: readonly string[]
): Promise<void> {
  try {
    const database = deps.openDeps.journalDatabase
    if (database.readOnly) {
      return
    }
    const outlasted = await resolveRecoveringLeases(deps)
    const listedOrder = new Map(listedIds.map((sessionId, index) => [sessionId, index]))
    const listed: AgentSessionRecord[] = []
    const others: AgentSessionRecord[] = []
    for (const sessionId of readUnsettledJournalSessionIds(database.db)) {
      const record = deps.openDeps.store.getRecord(sessionId)
      if (!deps.canSettle(record)) {
        dropUnreachableStatus(deps, sessionId, record)
        continue
      }
      if (listedOrder.has(sessionId)) {
        listed.push(record)
      } else {
        others.push(record)
      }
    }
    listed.sort(
      (left, right) =>
        (listedOrder.get(left.sessionId) ?? 0) - (listedOrder.get(right.sessionId) ?? 0)
    )
    // A recovery that outlasted its budget is still running: a second one beside it could hang the
    // same way, so its chat is opened unverified and the next attach or send resolves it.
    await deps.restoreListed(listed, (sessionId) =>
      outlasted.has(sessionId) ? Promise.resolve(true) : deps.resolveRecovery(sessionId)
    )
    // A listed chat the worker left closed (its tab closed meanwhile) is settled like any other.
    others.push(...listed.filter((record) => !deps.hasSession(record.sessionId)))
    for (const record of others) {
      // A journal open is synchronous SQLite: one chat per macrotask.
      await yieldToEventLoop()
      if (deps.isDisposed()) {
        return
      }
      await deps
        .serialize(record.sessionId, () => settleClosed(deps, record))
        .catch((error: unknown) => {
          deps.openDeps.logger.warn('settling a chat at startup failed', {
            scope: 'startup-settle-chat',
            sessionId: record.sessionId,
            error
          })
        })
    }
  } catch (error) {
    deps.openDeps.logger.warn('settling chats at startup failed', {
      scope: 'startup-settle',
      error
    })
  }
}

/**
 * A row no settle here can clear: its chat's record is gone, or this host does not serve its
 * provider. Dropped, so it is not selected every boot; an open writes it again if the chat is ever
 * opened here. Kept while the records import is owed, which may still bring the record.
 */
function dropUnreachableStatus(
  deps: StructuredAgentSessionStartupStateDeps,
  sessionId: string,
  record: AgentSessionRecord | null
): void {
  const database = deps.openDeps.journalDatabase
  if (!record && database.legacyRecordImportOwed) {
    return
  }
  try {
    deleteJournalSessionStatus(database.db, sessionId)
  } catch (error) {
    deps.openDeps.logger.warn('dropping an unreachable chat status failed', {
      scope: 'startup-drop-status',
      sessionId,
      error
    })
  }
}

/** Every lease a crash left `recovering`, listed or not: a provider process that outlived the crash
 *  is stopped and its death recorded, so the settle below reads one verdict per turn. */
async function resolveRecoveringLeases(
  deps: StructuredAgentSessionStartupStateDeps
): Promise<Set<string>> {
  const recovering = deps.openDeps.store
    .listRecords()
    .filter((record) => record.lease.handoffStage === 'recovering')
  const budgetMs = deps.recoveryBudgetMs ?? RECOVERY_BUDGET_MS
  const outlasted = new Set<string>()
  await forEachWithConcurrency(recovering, RECOVERY_CONCURRENCY, async ({ sessionId }) => {
    if (
      (await withTimeout<boolean | null>(deps.resolveRecovery(sessionId), budgetMs, null)) === null
    ) {
      outlasted.add(sessionId)
      deps.openDeps.logger.warn('a chat recovery outlasted startup; left unverified', {
        scope: 'startup-recovery-timeout',
        sessionId
      })
    }
  })
  return outlasted
}

/** A chat nothing holds open: settled and closed, never indexed, so it gets no status row. */
async function settleClosed(
  deps: StructuredAgentSessionStartupStateDeps,
  record: AgentSessionRecord,
  loaded?: JournalLoad
): Promise<boolean> {
  if (deps.isDisposed() || deps.hasSession(record.sessionId) || !deps.canSettle(record)) {
    return false
  }
  const opened = await openStructuredAgentSessionConversationJournal(deps.openDeps, record, {
    deferPerSessionImport: true,
    ...(loaded ? { loaded } : {})
  })
  await opened.session.journal.close()
  return true
}
