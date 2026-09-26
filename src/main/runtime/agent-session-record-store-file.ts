/**
 * On-disk layer for the durable agent-session store.
 *
 * Every mutation is a whole-file atomic transaction — temp write, fsync, rename — so a SIGKILL
 * at any point leaves either the previous committed state or the next one, never a torn lease.
 * That matters because this host restarts its runtime often; a half-written lease would be
 * indistinguishable from an owner whose identity cannot be verified.
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentSessionOperationRow } from '../../shared/agent-session-operation-ledger'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  isPersistedAgentSessionRecord,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import { normalizeLegacyHandoffRecord } from '../../shared/agent-session-legacy-handoff-lease'
import { agentSessionStoreBackupPath as backupPath } from './agent-session-record-store-write'
export { saveAgentSessionStore } from './agent-session-record-store-write'
import { parseAgentSessionTabTable, type AgentSessionTabTable } from './agent-session-tab-table'
import { serializeAgentSessionStoreState } from './agent-session-store-serialization'
import {
  readAgentSessionStorePrimary,
  type AgentSessionStorePrimaryBytes
} from './agent-session-store-primary-bytes'
import {
  isReadableAgentSessionStoreOperation,
  isReadableAgentSessionStoreUnusableRecord,
  isReadableRetiredAgentSessionClaimKey
} from './agent-session-store-row-rules'

export const AGENT_SESSION_STORE_SCHEMA_VERSION = 2 as const

export const AGENT_SESSION_STORE_FILE_NAME = 'agent-sessions.json'

export type RetiredAgentSessionClaimKey = { keyId: string; retiredAt: number }

export type AgentSessionStoreState = {
  schemaVersion: number
  hostId: string
  records: Map<string, AgentSessionRecord>
  operations: Map<string, AgentSessionOperationRow>
  retiredClaimKeys: RetiredAgentSessionClaimKey[]
  /** Rows this build cannot validate, kept with a durable refusal reason. */
  unreadableRecords: Map<string, { reason: string; raw: unknown }>
  /** Chat tab id → the conversation it shows; null until this store first records a tab. */
  sessionTabs: AgentSessionTabTable | null
}

export type LoadedAgentSessionStore = {
  state: AgentSessionStoreState
  storeFound: boolean
  /** True when the file was written by a newer schema; this host reads but never writes it. */
  readOnly: boolean
  /** True when the primary file was unusable and the previous committed copy was used. */
  recoveredFromBackup: boolean
  /** True when the normalized current-schema quarantine must be persisted. */
  needsRewrite: boolean
  /** True when decode mapped a lease value only the removed terminal handoff wrote. */
  legacyHandoffLeasesNormalized: boolean
  /** sha256 of the primary bytes `state` was parsed from; null when no primary was parsed. */
  primarySha256: string | null
  /** True when `state` also rests on the backup: a row was salvaged from it, or it could not be read. */
  dependsOnBackup: boolean
}

/**
 * The hash whose bytes alone determine `loaded.state`, or null when they do not. Salvage also reads
 * the backup, so the same primary bytes can load differently once the backup changes or is readable.
 */
export function agentSessionStoreExactPrimarySha256(
  loaded: LoadedAgentSessionStore
): string | null {
  return loaded.dependsOnBackup ? null : loaded.primarySha256
}

export function agentSessionStorePath(directory: string): string {
  return join(directory, AGENT_SESSION_STORE_FILE_NAME)
}

function emptyState(hostId: string): AgentSessionStoreState {
  return {
    schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION,
    hostId,
    records: new Map(),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs: null
  }
}

export function agentSessionStoreRevision(state: AgentSessionStoreState): string {
  return agentSessionStoreSerializedRevision(
    state.schemaVersion,
    serializeAgentSessionStoreState(state)
  )
}

/** The revision of a state whose serialization is already in hand. */
export function agentSessionStoreSerializedRevision(
  schemaVersion: number,
  serialized: string
): string {
  return createHash('sha256')
    .update(String(schemaVersion))
    .update('\0')
    .update(serialized)
    .digest('hex')
}

function parseState(
  raw: string,
  hostId: string
): Pick<
  LoadedAgentSessionStore,
  'state' | 'needsRewrite' | 'legacyHandoffLeasesNormalized'
> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is read back as `unknown` and validated below before use.
  const file = parsed as {
    schemaVersion?: unknown
    hostId?: unknown
    records?: unknown
    operations?: unknown
    retiredClaimKeys?: unknown
    unusableRecords?: unknown
    sessionTabs?: unknown
    visibleSessionIds?: unknown
  }
  if (
    !Number.isSafeInteger(file.schemaVersion) ||
    (file.schemaVersion as number) < 0 ||
    typeof file.hostId !== 'string'
  ) {
    return null
  }
  const schemaVersion = file.schemaVersion as number
  if (schemaVersion < AGENT_SESSION_STORE_SCHEMA_VERSION) {
    return null
  }
  if (
    schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION &&
    (typeof file.records !== 'object' || file.records === null || Array.isArray(file.records))
  ) {
    return null
  }
  if (
    schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION &&
    (typeof file.operations !== 'object' ||
      file.operations === null ||
      Array.isArray(file.operations) ||
      !Array.isArray(file.retiredClaimKeys) ||
      typeof file.unusableRecords !== 'object' ||
      file.unusableRecords === null ||
      Array.isArray(file.unusableRecords))
  ) {
    return null
  }
  const state = emptyState(hostId)
  state.schemaVersion = schemaVersion
  state.hostId = file.hostId
  let needsRewrite = false
  let legacyHandoffLeasesNormalized = false
  if (typeof file.records === 'object' && file.records !== null) {
    for (const [sessionId, value] of Object.entries(file.records)) {
      const decoded = isPersistedAgentSessionRecord(value)
        ? normalizeLegacyHandoffRecord(value)
        : null
      const record = decoded?.record ?? null
      if (record?.sessionId === sessionId) {
        state.records.set(sessionId, record)
        // Why: mapped while parsing, so every revision is taken over the same normalized state.
        legacyHandoffLeasesNormalized ||= decoded?.normalized === true
      } else {
        const valueSchemaVersion =
          typeof value === 'object' &&
          value !== null &&
          (value as { schemaVersion?: unknown }).schemaVersion
        const reason = record
          ? 'record_key_session_id_mismatch'
          : valueSchemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION
            ? 'current_shape_invalid'
            : 'unsupported_schema'
        state.unreadableRecords.set(sessionId, { reason, raw: value })
        needsRewrite ||= schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION
      }
    }
  }
  if (typeof file.unusableRecords === 'object' && file.unusableRecords !== null) {
    for (const [sessionId, value] of Object.entries(file.unusableRecords)) {
      if (!isReadableAgentSessionStoreUnusableRecord(value)) {
        if (schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION) {
          return null
        }
        continue
      }
      state.unreadableRecords.set(sessionId, { reason: value.reason, raw: value.raw })
    }
  }
  if (typeof file.operations === 'object' && file.operations !== null) {
    for (const [key, value] of Object.entries(file.operations)) {
      if (!isReadableAgentSessionStoreOperation(key, value)) {
        if (schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION) {
          return null
        }
        continue
      }
      state.operations.set(key, value)
    }
  }
  if (Array.isArray(file.retiredClaimKeys)) {
    for (const entry of file.retiredClaimKeys) {
      if (!isReadableRetiredAgentSessionClaimKey(entry)) {
        if (schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION) {
          return null
        }
        continue
      }
      state.retiredClaimKeys.push({ keyId: entry.keyId, retiredAt: entry.retiredAt })
    }
  }
  const sessionTabs = parseAgentSessionTabTable(
    file,
    state.records,
    schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION
  )
  if (!sessionTabs.valid) {
    return null
  }
  state.sessionTabs = sessionTabs.table
  return { state, needsRewrite, legacyHandoffLeasesNormalized }
}

/** A record the primary retained as unreadable may still have a valid copy in the previous
 *  committed state. Adopting it keeps the session reachable — the lease is re-adjudicated
 *  like any other — while the unreadable bytes stay quarantined verbatim. Returns whether the
 *  result rests on the backup. */
async function salvageUnreadableRecordsFromBackup(
  state: AgentSessionStoreState,
  backupFilePath: string,
  hostId: string
): Promise<boolean> {
  const missing = [...state.unreadableRecords.keys()].filter(
    (sessionId) => !state.records.has(sessionId)
  )
  if (missing.length === 0) {
    return false
  }
  let raw: string
  try {
    raw = await readFile(backupFilePath, 'utf-8')
  } catch (error) {
    // Why: a backup that failed to read may still hold the row, so the next load must look again.
    return !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
  }
  const backup = parseState(raw, hostId)
  if (!backup) {
    return false
  }
  let salvaged = false
  for (const sessionId of missing) {
    const record = backup.state.records.get(sessionId)
    if (record) {
      state.records.set(sessionId, record)
      salvaged = true
    }
  }
  return salvaged
}

/** `primary` is the primary's bytes when the caller already read them; omitted, they are read here. */
export async function loadAgentSessionStore(
  filePath: string,
  hostId: string,
  primary?: AgentSessionStorePrimaryBytes | null
): Promise<LoadedAgentSessionStore> {
  let unusableStoreFound = false
  const primaryBytes =
    primary === undefined ? await readAgentSessionStorePrimary(filePath) : primary
  if (primaryBytes) {
    const parsed = parseState(primaryBytes.bytes.toString('utf-8'), hostId)
    if (parsed) {
      const dependsOnBackup = await salvageUnreadableRecordsFromBackup(
        parsed.state,
        backupPath(filePath),
        hostId
      )
      return {
        ...parsed,
        storeFound: true,
        readOnly: parsed.state.schemaVersion > AGENT_SESSION_STORE_SCHEMA_VERSION,
        recoveredFromBackup: false,
        primarySha256: primaryBytes.sha256,
        dependsOnBackup
      }
    }
    unusableStoreFound = true
  }
  let backupRaw: string | null = null
  try {
    backupRaw = await readFile(backupPath(filePath), 'utf-8')
  } catch (error) {
    unusableStoreFound ||= !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
  }
  if (backupRaw !== null) {
    const parsed = parseState(backupRaw, hostId)
    if (parsed) {
      return {
        ...parsed,
        storeFound: true,
        readOnly: parsed.state.schemaVersion > AGENT_SESSION_STORE_SCHEMA_VERSION,
        recoveredFromBackup: true,
        primarySha256: null,
        dependsOnBackup: false
      }
    }
    unusableStoreFound = true
  }
  if (unusableStoreFound) {
    throw new Error('agent_session_store_corrupt')
  }
  return {
    state: emptyState(hostId),
    storeFound: false,
    readOnly: false,
    recoveredFromBackup: false,
    needsRewrite: false,
    legacyHandoffLeasesNormalized: false,
    primarySha256: null,
    dependsOnBackup: false
  }
}
