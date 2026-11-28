import { lstatSync, statSync, type Stats } from 'node:fs'
import { readNodeFileWithinLimit } from '../../../../shared/file-content/node-bounded-file-reader'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionOperationRow } from '../../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import { decodePersistedAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import type { AgentSessionTabTable } from '../../../runtime/agent-session/records/agent-session-tab-table'
import type { RetiredAgentSessionClaimKey } from '../../../runtime/agent-session/records/agent-session-store-state'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreRecord,
  isReadableRetiredAgentSessionClaimKey
} from '../../../runtime/agent-session/records/agent-session-store-row-rules'
import { JournalDamageError } from '../replay/journal-open-failure'
import { AgentSessionJournalError } from '../writing/journal-write-guards'
import { journalLegacyRecordPaths } from './journal-legacy-record-paths'
import { parseLegacyAgentSessionTabTable } from './journal-legacy-record-tabs'

type RecordFile = {
  path: string
  identity: string | null
}

type LegacyRecordState = {
  hostId: string
  records: Map<string, AgentSessionRecord>
  unreadableRecords: Map<string, unknown>
  operations: Map<string, AgentSessionOperationRow>
  retiredClaimKeys: RetiredAgentSessionClaimKey[]
  sessionTabs: AgentSessionTabTable | null
}

export type JournalLegacyRecordSnapshot = {
  files: readonly [RecordFile, RecordFile]
  loaded: { state: LegacyRecordState; fromBackup: boolean } | null
}

function recordFileIdentity(stats: Stats): string {
  return JSON.stringify([stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs])
}

function captureRecordFile(path: string): string | null {
  // A dangling link is present and cannot certify absence of the old file.
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    return null
  }
  return recordFileIdentity(statSync(path))
}

export function assertJournalLegacyRecordFilesStable(files: readonly RecordFile[]): void {
  for (const { path, identity } of files) {
    if (captureRecordFile(path) !== identity) {
      throw new Error('the original chat records changed during initialization')
    }
  }
}

async function readRecordFile(
  file: RecordFile,
  maxBytes: number
): Promise<LegacyRecordState | null> {
  const { buffer, stats } = await readNodeFileWithinLimit(file.path, maxBytes, {
    regularFileOnly: true
  })
  if (
    recordFileIdentity(stats) !== file.identity ||
    buffer.byteLength !== stats.size ||
    captureRecordFile(file.path) !== file.identity
  ) {
    throw new Error('the original chat records changed during initialization')
  }
  return parseRecordFile(buffer.toString('utf8'))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRecordFile(raw: string): LegacyRecordState | null {
  let file: unknown
  try {
    file = JSON.parse(raw)
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
  if (!isObject(file)) {
    return null
  }
  if (typeof file.schemaVersion === 'number' && file.schemaVersion > 2) {
    throw new AgentSessionJournalError('journal_read_only', 'the original chat records are newer')
  }
  if (
    file.schemaVersion !== 2 ||
    typeof file.hostId !== 'string' ||
    !isObject(file.records) ||
    !isObject(file.operations) ||
    !isObject(file.unusableRecords) ||
    !Array.isArray(file.retiredClaimKeys)
  ) {
    return null
  }
  const records = new Map<string, AgentSessionRecord>()
  const unreadableRecords = new Map<string, unknown>()
  for (const [id, value] of Object.entries(file.records)) {
    if (isReadableAgentSessionStoreRecord(id, value)) {
      records.set(id, decodePersistedAgentSessionRecord(value).record)
    } else {
      unreadableRecords.set(id, value)
    }
  }
  for (const [id, value] of Object.entries(file.unusableRecords)) {
    if (!isObject(value) || typeof value.reason !== 'string' || !value.reason) {
      return null
    }
    unreadableRecords.set(id, value.raw)
  }
  const operations = new Map<string, AgentSessionOperationRow>()
  for (const [key, value] of Object.entries(file.operations)) {
    if (!isReadableAgentSessionStoreOperation(key, value)) {
      return null
    }
    operations.set(key, value)
  }
  const retiredClaimKeys: RetiredAgentSessionClaimKey[] = []
  for (const value of file.retiredClaimKeys) {
    if (!isReadableRetiredAgentSessionClaimKey(value)) {
      return null
    }
    retiredClaimKeys.push(value)
  }
  const sessionTabs = parseLegacyAgentSessionTabTable(file, records)
  if (sessionTabs === undefined) {
    return null
  }
  return {
    hostId: file.hostId,
    records,
    unreadableRecords,
    operations,
    retiredClaimKeys,
    sessionTabs
  }
}

/** Only proven absence or malformed content permits recovery from an older copy. */
export async function readJournalLegacyRecordSnapshot(
  stateDirectory: string,
  maxBytes: number
): Promise<JournalLegacyRecordSnapshot> {
  const [primaryPath, backupPath] = journalLegacyRecordPaths(stateDirectory)
  const files = [
    { path: primaryPath, identity: captureRecordFile(primaryPath) },
    { path: backupPath, identity: captureRecordFile(backupPath) }
  ] as const
  const [primary, backup] = files
  if (primary.identity === null && backup.identity === null) {
    return { files, loaded: null }
  }
  const state = primary.identity === null ? null : await readRecordFile(primary, maxBytes)
  const missing = state
    ? [...state.unreadableRecords.keys()].filter((id) => !state.records.has(id))
    : []
  const recovered =
    backup.identity !== null && (!state || missing.length > 0)
      ? await readRecordFile(backup, maxBytes)
      : null
  assertJournalLegacyRecordFilesStable(files)
  if (state) {
    for (const id of missing) {
      const record = recovered?.records.get(id)
      if (record) {
        state.records.set(id, record)
      }
    }
    return { files, loaded: { state, fromBackup: false } }
  }
  if (recovered) {
    return { files, loaded: { state: recovered, fromBackup: true } }
  }
  throw new JournalDamageError('the original chat records and their backup could not be read')
}
