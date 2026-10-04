// The one-time copy of `agent-sessions.json` into the chat journal database, inside the version-4
// migration (journal-database.ts). The file and its `.bak` are only ever read: an older build that
// still uses them finds them as it left them.
//
// Never blocks the host. A file no read will make usable is reported, nothing is copied, and the
// migration completes: the file is left untouched, but a later repair of it is never imported. A
// read that can clear leaves the copy owed, and every later launch retries it until one reads the
// file, finds it absent or unusable, or the import is retired.

import { nextAgentSessionFence } from '../../shared/agent-session-next-fence'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  NO_LEGACY_JOURNAL_RECORDS,
  type JournalLegacyRecordImport
} from '../native-chat/agent-session-journal/journal-database'
import { raiseAgentSessionFencesAfterBackupRecovery } from './agent-session-backup-recovery-fence'
import {
  legacyAgentSessionStorePath,
  loadAgentSessionStore,
  type AgentSessionStoreState
} from './agent-session-record-store-file'
import {
  insertAgentSessionStoreRowsIfAbsent,
  withoutRetiredLeaseLatches,
  type AgentSessionStoreImportRows
} from './agent-session-record-rows'
import { isReadableAgentSessionStoreRecord } from './agent-session-store-row-rules'

export type LegacyAgentSessionRecords =
  | { kind: 'absent' }
  /** The primary parsed, or it was unusable and `.bak` parsed (`fromBackup`). */
  | { kind: 'loaded'; state: AgentSessionStoreState; fromBackup: boolean }
  /** Present, and neither the primary nor `.bak` parses: no read will change that. */
  | { kind: 'unusable'; error: unknown }
  /** Reading the primary or `.bak` failed in a way that can clear (EACCES, EIO, EMFILE). */
  | { kind: 'unavailable'; error: unknown }

/** Why the copy found nothing to take, or took less than the file holds. */
export type LegacyAgentSessionRecordImportReport =
  | { kind: 'unusable' | 'unavailable'; error: unknown }
  | { kind: 'host-mismatch'; fileHostId: string; hostId: string }

function readFailedTransiently(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined
  return (
    !(error instanceof Error && error.message === 'agent_session_store_corrupt') ||
    (typeof cause === 'object' && cause !== null && 'code' in cause && cause.code !== 'ENOENT')
  )
}

/** Never throws. */
export async function readLegacyAgentSessionRecords(
  stateDirectory: string,
  hostId: string
): Promise<LegacyAgentSessionRecords> {
  try {
    const loaded = await loadAgentSessionStore(legacyAgentSessionStorePath(stateDirectory), hostId)
    return loaded.storeFound
      ? { kind: 'loaded', state: loaded.state, fromBackup: loaded.recoveredFromBackup }
      : { kind: 'absent' }
  } catch (error) {
    return readFailedTransiently(error)
      ? { kind: 'unavailable', error }
      : { kind: 'unusable', error }
  }
}

function safeFence(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * A readable record whose id also has a set-aside copy: an older build recovered the readable one
 * from its backup and could not read the newer copy, which may already have granted fences the
 * readable one cannot show. The next grant must clear both.
 */
function withFloorAboveSetAsideCopy(record: AgentSessionRecord, raw: unknown): AgentSessionRecord {
  let floor = Math.max(record.lease.minimumNextFence ?? 0, nextAgentSessionFence(record.lease) + 1)
  const rawLease = typeof raw === 'object' && raw !== null && 'lease' in raw ? raw.lease : undefined
  if (typeof rawLease === 'object' && rawLease !== null && 'runtimeFence' in rawLease) {
    const runtimeFence = safeFence(rawLease.runtimeFence)
    const minimumNextFence =
      'minimumNextFence' in rawLease && rawLease.minimumNextFence !== undefined
        ? safeFence(rawLease.minimumNextFence)
        : undefined
    if (runtimeFence !== null && minimumNextFence !== null) {
      floor = Math.max(floor, nextAgentSessionFence({ runtimeFence, minimumNextFence }))
    }
  }
  if (!Number.isSafeInteger(floor)) {
    throw new Error('agent_session_fence_exhausted')
  }
  return { ...record, lease: { ...record.lease, minimumNextFence: floor } }
}

function importRows(
  state: AgentSessionStoreState,
  fromBackup: boolean
): AgentSessionStoreImportRows {
  const records = new Map(state.records)
  if (fromBackup) {
    // The commit the backup lost may have granted a fence it cannot show: main's rule for this state.
    raiseAgentSessionFencesAfterBackupRecovery({ ...state, records })
  }
  const rows: AgentSessionStoreImportRows['records'] = []
  for (const [sessionId, loaded] of records) {
    const setAside = state.unreadableRecords.get(sessionId)
    const record = setAside ? withFloorAboveSetAsideCopy(loaded, setAside.raw) : loaded
    const json = JSON.stringify({ ...record, lease: withoutRetiredLeaseLatches(record.lease) })
    // A record the load rules refuse is kept as its bytes, which every load then sets aside.
    rows.push([
      sessionId,
      isReadableAgentSessionStoreRecord(sessionId, JSON.parse(json)) ? json : JSON.stringify(loaded)
    ])
  }
  for (const [sessionId, { raw }] of state.unreadableRecords) {
    if (!records.has(sessionId)) {
      // Verbatim: a build that can read it gets it back, and this one derives it as unreadable.
      rows.push([sessionId, JSON.stringify(raw ?? null)])
    }
  }
  return {
    records: rows,
    operations: [...state.operations].map(([key, row]) => [key, JSON.stringify(row)]),
    retiredClaimKeys: state.retiredClaimKeys,
    sessionTabs:
      state.sessionTabs?.entries().map(([tabId, sessionId]) => ({ tabId, sessionId })) ?? null
  }
}

/** What the migration runs for `legacy`, each failure reported once here. */
export function legacyAgentSessionRecordImport(
  legacy: LegacyAgentSessionRecords,
  hostId: string,
  report: (report: LegacyAgentSessionRecordImportReport) => void
): JournalLegacyRecordImport {
  switch (legacy.kind) {
    case 'absent':
      return NO_LEGACY_JOURNAL_RECORDS
    case 'unavailable':
      report(legacy)
      return { owed: true }
    case 'unusable':
      report(legacy)
      return NO_LEGACY_JOURNAL_RECORDS
    case 'loaded':
      break
  }
  let rows: AgentSessionStoreImportRows
  try {
    rows = importRows(legacy.state, legacy.fromBackup)
  } catch (error) {
    report({ kind: 'unusable', error })
    return NO_LEGACY_JOURNAL_RECORDS
  }
  if (legacy.state.hostId !== hostId) {
    // Owners it names answer `unresolved` against this host, the conservative verdict.
    report({ kind: 'host-mismatch', fileHostId: legacy.state.hostId, hostId })
  }
  return { owed: false, write: (db) => insertAgentSessionStoreRowsIfAbsent(db, rows) }
}
