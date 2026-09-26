// What a restart owes a persisted session, and what it does NOT.
//
// It owes reconciliation — every lease loaded from disk names an owner from a process generation
// that no longer exists, and adjudicating that is startup's job. It owes an exit from any recovery
// stage the evidence now permits, a settlement for any turn a restart cut off, and a status row for
// every listed chat. It does not owe a provider child, and it does not owe an open journal: a chat
// whose saved status still matches its journal's position is listed from that copy, and its journal
// opens when something reads it.
//
// One pass, kicked once after the host installs, in two phases:
// 1. before reconcile: each listed chat's saved status is checked against its journal's position;
//    a match publishes the row, anything else is remembered as a miss;
// 2. after reconcile: recovery exits, then settlement of every open conversation, then each miss
//    and each listed record still owing settlement is opened (unless already open), settled, and
//    closed again if nothing but this pass wanted it open.
// Every step runs under its own session's lock with a yield between chats, so a read or a send
// jumps the queue and waits for one chat at most.

import { existsSync } from 'node:fs'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import { yieldToEventLoop } from '../../../shared/event-loop-yield'
import {
  STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION,
  type StructuredAgentSessionSavedStatus
} from '../../../shared/structured-agent-session-saved-status'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { sameJournalCursor } from '../agent-session-journal/journal-cursor'
import { probeJournalCursor } from '../agent-session-journal/journal-cursor-probe'
import { findJournalFileFormatRemnant } from '../agent-session-journal/journal-file-format-remnant'
import { journalDatabaseFile, journalDirectoryFor } from '../agent-session-journal/journal-paths'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'
import { adapterSupportsRecord } from './structured-agent-session-provider-support'
import { structuredSessionRecoveryIsResolvable } from './structured-agent-session-recovery-resolution'
import {
  retryLoadedStructuredAgentSessionSettlement,
  structuredAgentSessionOwesSettlement
} from './structured-agent-session-settlement-retry'

/** Which chats a user is most likely to look at first; absent on hosts with no saved desktop
 *  session (`orca serve`, SSH), where the pass keeps the listing's order. */
export type StructuredAgentSessionStartupPriority = {
  activeWorkspaceId: string | null
  visibleWorkspaceIds: ReadonlySet<string>
}

/** One chat's share of the pass, run under its lock. `session` is the conversation open when the
 *  step began; `closeIfUnreached` drops it again unless a reader reached it during the step. */
export type StructuredAgentSessionStartupStep = <T>(
  sessionId: string,
  step: (context: {
    session: StructuredAgentSessionHostSession | undefined
    closeIfUnreached: () => Promise<void>
  }) => Promise<T>
) => Promise<T | undefined>

export type StructuredAgentSessionStartupPassDeps = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'listRecords' | 'listVisibleSessionIds'>
  journalRoot: string
  savedStatus?: {
    read: (sessionId: string) => StructuredAgentSessionSavedStatus | null
    prune: (keep: (sessionId: string) => boolean) => void
  }
  supportsRecord: (record: AgentSessionRecord) => boolean
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  step: StructuredAgentSessionStartupStep
  seed: (sessionId: string, saved: StructuredAgentSessionSavedStatus) => void
  reconcile: () => Promise<AgentSessionWireRefusal | null>
  resolveRecovery: (sessionId: string) => Promise<unknown>
  /** The host's one open, for a caller inside the session's lock; it re-checks for an open entry. */
  open: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>
  settle: (sessionId: string, journal: AgentSessionJournal) => Promise<boolean>
  onError: (sessionId: string, error: unknown) => void
  now: () => number
}

export type StructuredAgentSessionStartupPass = {
  /** Latched: every later call is the same pass, retried only after a failure. */
  run: (priority?: StructuredAgentSessionStartupPriority) => Promise<void>
  /** A later reconcile settled every lease: settle what it flagged on open conversations. */
  onReconciled: () => void
}

/** A compaction or rewind the last run left prepared: the chat's open settles it and writes a row,
 *  so its saved status cannot equal what that open publishes. */
function openOwesCommandSettlement(record: AgentSessionRecord): boolean {
  const command = record.conversationCommand
  return (
    (command?.command === 'compact' && command.phase === 'prepared') ||
    record.rewind?.phase === 'prepared' ||
    record.rewind?.phase === 'provider-succeeded'
  )
}

function journalDirFor(root: string, record: AgentSessionRecord): string {
  return journalDirectoryFor(root, {
    workspaceId: record.location.workspaceId,
    sessionId: record.sessionId
  })
}

/** Active workspace first, then the other visible ones, then the rest; listing order within each. */
export function orderStartupSessionIds(
  sessionIds: readonly string[],
  workspaceOf: (sessionId: string) => string | undefined,
  priority: StructuredAgentSessionStartupPriority | undefined
): string[] {
  if (!priority) {
    return [...sessionIds]
  }
  const tier = (sessionId: string): number => {
    const workspaceId = workspaceOf(sessionId)
    if (workspaceId !== undefined && workspaceId === priority.activeWorkspaceId) {
      return 0
    }
    return workspaceId !== undefined && priority.visibleWorkspaceIds.has(workspaceId) ? 1 : 2
  }
  return sessionIds
    .map((sessionId, index) => ({ sessionId, index, tier: tier(sessionId) }))
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
    .map(({ sessionId }) => sessionId)
}

export function createStructuredAgentSessionStartupPass(
  deps: StructuredAgentSessionStartupPassDeps
): StructuredAgentSessionStartupPass {
  let running: Promise<void> | null = null
  let settledOpenOnce = false
  const listed = (sessionId: string): boolean =>
    deps.store.listVisibleSessionIds().includes(sessionId)
  const supportedRecord = (sessionId: string): AgentSessionRecord | null => {
    const record = deps.store.getRecord(sessionId)
    return record && deps.supportsRecord(record) ? record : null
  }

  /** Phase 1's step: true when the saved copy was proven current and published. */
  const seedFromSavedStatus = (record: AgentSessionRecord): boolean => {
    let saved: StructuredAgentSessionSavedStatus | null = null
    try {
      saved = deps.savedStatus?.read(record.sessionId) ?? null
    } catch (error) {
      // A saved copy that cannot be read is a miss, never a lost chat.
      deps.onError(record.sessionId, error)
    }
    if (
      !saved ||
      saved.v !== STRUCTURED_AGENT_SESSION_STATUS_PROJECTION_VERSION ||
      openOwesCommandSettlement(record)
    ) {
      return false
    }
    const position = probeJournalCursor(journalDirFor(deps.journalRoot, record), record.sessionId)
    if (!position || !sameJournalCursor(saved.cursor, position)) {
      return false
    }
    deps.seed(record.sessionId, saved)
    return true
  }

  const settleOpenConversations = async (): Promise<void> => {
    for (const sessionId of deps.sessions.keys()) {
      await deps
        .step(sessionId, async ({ session }) => {
          if (session) {
            await deps.settle(sessionId, session.journal)
          }
        })
        .catch((error: unknown) => deps.onError(sessionId, error))
    }
  }

  /** Phase 2.3's step: open unless open, always settle, and close what only this pass wanted. */
  const openAndSettle = async (sessionId: string): Promise<void> => {
    await deps.step(sessionId, async ({ session, closeIfUnreached }) => {
      const record = supportedRecord(sessionId)
      if (!record || !listed(sessionId)) {
        return
      }
      if (!session) {
        const dir = journalDirFor(deps.journalRoot, record)
        // No rows means no turn, and a chat with no turn has no row to publish.
        if (!existsSync(journalDatabaseFile(dir)) && !findJournalFileFormatRemnant(dir)) {
          return
        }
      }
      const open = session ?? (await deps.open(sessionId))
      if (!open) {
        return
      }
      await deps.settle(sessionId, open.journal)
      if (!session) {
        await closeIfUnreached()
      }
    })
  }

  const runOnce = async (priority?: StructuredAgentSessionStartupPriority): Promise<void> => {
    const startedAt = deps.now()
    const misses: string[] = []
    let seeded = 0
    for (const sessionId of deps.store.listVisibleSessionIds()) {
      await deps
        .step(sessionId, async ({ session }) => {
          const record = supportedRecord(sessionId)
          if (session || !record || !listed(sessionId)) {
            return
          }
          if (seedFromSavedStatus(record)) {
            seeded += 1
          } else {
            misses.push(sessionId)
          }
        })
        .catch((error: unknown) => deps.onError(sessionId, error))
      await yieldToEventLoop()
    }
    try {
      deps.savedStatus?.prune((sessionId) => deps.store.getRecord(sessionId) !== null)
    } catch (error) {
      deps.onError('startup-pass', error)
    }
    console.info(
      `[structured-agent-session] startup status: ${seeded} from saved copies, ${misses.length} to open, ${deps.now() - startedAt} ms`
    )
    // Settled either way: a failed reconcile still leaves the opens and settlements below owed.
    const reconciled = await deps.reconcile().then(
      (refusal) => refusal === null,
      (error: unknown) => {
        deps.onError('startup-pass', error)
        return false
      }
    )
    if (reconciled) {
      // Every record, hidden ones too: an orphaned owner of a closed tab is still this host's.
      for (const record of deps.store.listRecords()) {
        if (structuredSessionRecoveryIsResolvable(record)) {
          await deps
            .resolveRecovery(record.sessionId)
            .catch((error: unknown) => deps.onError(record.sessionId, error))
        }
      }
    }
    await settleOpenConversations()
    settledOpenOnce = true
    const owed = deps.store
      .listVisibleSessionIds()
      .filter((sessionId) => structuredAgentSessionOwesSettlement(deps.store.getRecord(sessionId)))
    const targets = orderStartupSessionIds(
      [...new Set([...misses, ...owed])],
      (sessionId) => deps.store.getRecord(sessionId)?.location.workspaceId,
      priority
    )
    for (const sessionId of targets) {
      // Logged once, never retried by the pass: the first read reports it.
      await openAndSettle(sessionId).catch((error: unknown) => deps.onError(sessionId, error))
      await yieldToEventLoop()
    }
  }

  return {
    run: (priority) => {
      running ??= runOnce(priority).catch((error: unknown) => {
        running = null
        throw error
      })
      return running
    },
    onReconciled: () => {
      if (settledOpenOnce) {
        void settleOpenConversations()
      }
    }
  }
}

/** The pass over a host's own deps: its store, journals, saved statuses and settlement. */
export function createStructuredAgentSessionHostStartupPass(
  deps: StructuredAgentSessionHostDeps,
  wiring: Pick<
    StructuredAgentSessionStartupPassDeps,
    'sessions' | 'step' | 'seed' | 'reconcile' | 'resolveRecovery' | 'open' | 'now'
  >
): StructuredAgentSessionStartupPass {
  return createStructuredAgentSessionStartupPass({
    ...wiring,
    store: deps.store,
    journalRoot: deps.journalRoot,
    ...(deps.savedStatus ? { savedStatus: deps.savedStatus } : {}),
    supportsRecord: (record) => adapterSupportsRecord(deps.adapter, record),
    settle: (sessionId, journal) =>
      retryLoadedStructuredAgentSessionSettlement({ deps, sessionId, journal, now: wiring.now }),
    onError: (sessionId, error) => deps.onEventSinkError?.({ sessionId, error })
  })
}
