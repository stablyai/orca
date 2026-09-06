/**
 * On-disk layer for the durable agent-session store.
 *
 * Every mutation is a whole-file atomic transaction — temp write, fsync, rename — so a SIGKILL
 * at any point leaves either the previous committed state or the next one, never a torn lease.
 * That matters because this host restarts its runtime often; a half-written lease would be
 * indistinguishable from an owner whose identity cannot be verified.
 */

import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  agentSessionOperationKey,
  isAgentSessionOperationRow,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  isAgentSessionRecord,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import {
  copyFileDurable,
  durableWriteTempPath,
  renameDurable,
  writeTempFileDurable
} from '../durable-file-write'
import { parseVisibleSessionIds } from './agent-session-visible-tab-index'
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
  /** Structured sessions that currently have a visible chat tab. */
  visibleSessionIds: Set<string>
  /** True once this store has committed the visibility index field. */
  visibleSessionIdsIndexPresent: boolean
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
}

export function agentSessionStorePath(directory: string): string {
  return join(directory, AGENT_SESSION_STORE_FILE_NAME)
}

const backupPath = (filePath: string): string => `${filePath}.bak`

function emptyState(hostId: string): AgentSessionStoreState {
  return {
    schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION,
    hostId,
    records: new Map(),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    visibleSessionIds: new Set(),
    visibleSessionIdsIndexPresent: false
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
): { state: AgentSessionStoreState; needsRewrite: boolean } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null
  }
  const file = parsed as {
    schemaVersion?: unknown
    hostId?: unknown
    records?: unknown
    operations?: unknown
    retiredClaimKeys?: unknown
    unusableRecords?: unknown
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
  if (typeof file.records === 'object' && file.records !== null) {
    for (const [sessionId, value] of Object.entries(file.records)) {
      const record = isAgentSessionRecord(value) ? value : null
      if (record?.sessionId === sessionId) {
        state.records.set(sessionId, record)
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
  const visibleSessionIds = parseVisibleSessionIds(
    file.visibleSessionIds,
    schemaVersion,
    AGENT_SESSION_STORE_SCHEMA_VERSION
  )
  if (!visibleSessionIds.valid) {
    return null
  }
  state.visibleSessionIdsIndexPresent = visibleSessionIds.present
  visibleSessionIds.ids.forEach((sessionId) => state.visibleSessionIds.add(sessionId))
  return { state, needsRewrite }
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
      state: parsed.state,
      storeFound: true,
      readOnly: parsed.state.schemaVersion > AGENT_SESSION_STORE_SCHEMA_VERSION,
      recoveredFromBackup,
      needsRewrite: parsed.needsRewrite
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
    needsRewrite: false
  }
}

/**
 * Commit the whole state. The live path is never absent: the new content is made durable in a temp
 * file first, a validated primary is COPIED to the backup, and only then does the rename publish it.
 * Backup recovery keeps the known-good backup in place while publishing the repaired primary.
 *
 * The old ordering renamed the live file aside before writing the new one, so a death in that
 * window left the profile with a backup and no primary — which is exactly the state that wedged a
 * real profile. Copy, don't move.
 */
export async function saveAgentSessionStore(
  filePath: string,
  state: AgentSessionStoreState,
  options: { primaryStatus: 'validated' | 'unusable-or-absent' }
): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const tmpPath = durableWriteTempPath(filePath)
  try {
    await writeTempFileDurable(tmpPath, serializeAgentSessionStoreState(state), 0o600)
    // Only a primary parsed under the transaction lock may replace the backup. During recovery the
    // primary is corrupt or absent, so the known-good backup must survive until publication.
    if (options.primaryStatus === 'validated') {
      await copyFileDurable(filePath, backupPath(filePath))
    }
    await renameDurable(tmpPath, filePath)
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}
