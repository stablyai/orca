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
import {
  agentSessionOperationKey,
  isAgentSessionOperationRow,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
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
  return createHash('sha256')
    .update(String(state.schemaVersion))
    .update('\0')
    .update(serializeAgentSessionStoreState(state))
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
      if (typeof value !== 'object' || value === null) {
        if (schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION) {
          return null
        }
        continue
      }
      const unusable = value as { reason?: unknown; raw?: unknown }
      if (typeof unusable.reason !== 'string' || unusable.reason.length === 0) {
        if (schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION) {
          return null
        }
        continue
      }
      state.unreadableRecords.set(sessionId, { reason: unusable.reason, raw: unusable.raw })
    }
  }
  if (typeof file.operations === 'object' && file.operations !== null) {
    for (const [key, value] of Object.entries(file.operations)) {
      if (!isAgentSessionOperationRow(value)) {
        if (schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION) {
          return null
        }
        continue
      }
      if (key !== agentSessionOperationKey(value.callerKey, value.operationId)) {
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
      const key = entry as Partial<RetiredAgentSessionClaimKey>
      if (
        typeof key?.keyId !== 'string' ||
        key.keyId.length === 0 ||
        key.keyId.length > 512 ||
        !Number.isSafeInteger(key.retiredAt) ||
        (key.retiredAt as number) < 0
      ) {
        if (schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION) {
          return null
        }
        continue
      }
      state.retiredClaimKeys.push({ keyId: key.keyId, retiredAt: key.retiredAt as number })
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
 *  like any other — while the unreadable bytes stay quarantined verbatim. */
async function salvageUnreadableRecordsFromBackup(
  state: AgentSessionStoreState,
  backupFilePath: string,
  hostId: string
): Promise<void> {
  const missing = [...state.unreadableRecords.keys()].filter(
    (sessionId) => !state.records.has(sessionId)
  )
  if (missing.length === 0) {
    return
  }
  let raw: string
  try {
    raw = await readFile(backupFilePath, 'utf-8')
  } catch {
    return
  }
  const backup = parseState(raw, hostId)
  if (!backup) {
    return
  }
  for (const sessionId of missing) {
    const record = backup.state.records.get(sessionId)
    if (record) {
      state.records.set(sessionId, record)
    }
  }
}

export async function loadAgentSessionStore(
  filePath: string,
  hostId: string
): Promise<LoadedAgentSessionStore> {
  let unusableStoreFound = false
  for (const [candidate, recoveredFromBackup] of [
    [filePath, false],
    [backupPath(filePath), true]
  ] as const) {
    let raw: string
    try {
      raw = await readFile(candidate, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Only a missing or unparseable primary means "fall back". A transient read failure
        // (EACCES, EIO, EMFILE) says nothing about the primary's contents, and treating it as
        // recovery would replace newer state with a stale backup and latch the recovery path.
        if (!recoveredFromBackup) {
          throw new Error('agent_session_store_corrupt')
        }
        unusableStoreFound = true
      }
      continue
    }
    const parsed = parseState(raw, hostId)
    if (!parsed) {
      unusableStoreFound = true
      continue
    }
    if (!recoveredFromBackup) {
      await salvageUnreadableRecordsFromBackup(parsed.state, backupPath(filePath), hostId)
    }
    return {
      ...parsed,
      storeFound: true,
      readOnly: parsed.state.schemaVersion > AGENT_SESSION_STORE_SCHEMA_VERSION,
      recoveredFromBackup
    }
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
    legacyHandoffLeasesNormalized: false
  }
}
