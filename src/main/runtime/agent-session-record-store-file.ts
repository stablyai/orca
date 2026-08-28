/**
 * On-disk layer for the durable agent-session store.
 *
 * Every mutation is a whole-file atomic transaction — temp write, fsync, rename — so a SIGKILL
 * at any point leaves either the previous committed state or the next one, never a torn lease.
 * That matters because this host restarts its runtime often; a half-written lease would be
 * indistinguishable from an owner whose identity cannot be verified.
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  agentSessionOperationKey,
  isAgentSessionOperationRow,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import { isAgentSessionRecord, type AgentSessionRecord } from '../../shared/agent-session-record'
import { durableWriteTempPath, writeFileDurable } from '../durable-file-write'

export const AGENT_SESSION_STORE_SCHEMA_VERSION = 1 as const

export const AGENT_SESSION_STORE_FILE_NAME = 'agent-sessions.json'

export type RetiredAgentSessionClaimKey = { keyId: string; retiredAt: number }

export type AgentSessionStoreState = {
  schemaVersion: number
  hostId: string
  records: Map<string, AgentSessionRecord>
  operations: Map<string, AgentSessionOperationRow>
  retiredClaimKeys: RetiredAgentSessionClaimKey[]
  /** Rows this build cannot validate, kept verbatim so a rollback cannot delete another host's work. */
  unreadableRecords: Map<string, unknown>
}

export type LoadedAgentSessionStore = {
  state: AgentSessionStoreState
  storeFound: boolean
  /** True when the file was written by a newer schema; this host reads but never writes it. */
  readOnly: boolean
  /** True when the primary file was unusable and the previous committed copy was used. */
  recoveredFromBackup: boolean
}

export function agentSessionStorePath(directory: string): string {
  return join(directory, AGENT_SESSION_STORE_FILE_NAME)
}

function backupPath(filePath: string): string {
  return `${filePath}.bak`
}

function emptyState(hostId: string): AgentSessionStoreState {
  return {
    schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION,
    hostId,
    records: new Map(),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map()
  }
}

export function agentSessionStoreRevision(state: AgentSessionStoreState): string {
  return createHash('sha256')
    .update(String(state.schemaVersion))
    .update('\0')
    .update(serializeState(state))
    .digest('hex')
}

function parseState(raw: string, hostId: string): { state: AgentSessionStoreState } | null {
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
  }
  if (
    !Number.isSafeInteger(file.schemaVersion) ||
    (file.schemaVersion as number) < 0 ||
    typeof file.hostId !== 'string'
  ) {
    return null
  }
  const schemaVersion = file.schemaVersion as number
  if (
    schemaVersion <= AGENT_SESSION_STORE_SCHEMA_VERSION &&
    (typeof file.records !== 'object' ||
      file.records === null ||
      Array.isArray(file.records) ||
      typeof file.operations !== 'object' ||
      file.operations === null ||
      Array.isArray(file.operations) ||
      (schemaVersion === AGENT_SESSION_STORE_SCHEMA_VERSION &&
        !Array.isArray(file.retiredClaimKeys)))
  ) {
    return null
  }
  const state = emptyState(hostId)
  state.schemaVersion = schemaVersion
  state.hostId = file.hostId
  if (typeof file.records === 'object' && file.records !== null) {
    for (const [sessionId, value] of Object.entries(file.records)) {
      if (isAgentSessionRecord(value) && value.sessionId === sessionId) {
        state.records.set(sessionId, value)
      } else {
        // Why: a record this build cannot read must not silently vanish, and must never be
        // granted a writer; keep it and refuse ownership for that session id.
        state.unreadableRecords.set(sessionId, value)
      }
    }
  }
  if (typeof file.operations === 'object' && file.operations !== null) {
    for (const [key, value] of Object.entries(file.operations)) {
      if (!isAgentSessionOperationRow(value)) {
        if (schemaVersion <= AGENT_SESSION_STORE_SCHEMA_VERSION) {
          return null
        }
        continue
      }
      if (key !== agentSessionOperationKey(value.callerKey, value.operationId)) {
        if (schemaVersion <= AGENT_SESSION_STORE_SCHEMA_VERSION) {
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
        if (schemaVersion <= AGENT_SESSION_STORE_SCHEMA_VERSION) {
          return null
        }
        continue
      }
      state.retiredClaimKeys.push({ keyId: key.keyId, retiredAt: key.retiredAt as number })
    }
  }
  return { state }
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
        unusableStoreFound = true
      }
      continue
    }
    const parsed = parseState(raw, hostId)
    if (!parsed) {
      unusableStoreFound = true
      continue
    }
    return {
      state: parsed.state,
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
    recoveredFromBackup: false
  }
}

function serializeState(state: AgentSessionStoreState): string {
  const records: Record<string, unknown> = Object.create(null)
  for (const [sessionId, value] of state.unreadableRecords) {
    records[sessionId] = value
  }
  for (const [sessionId, record] of state.records) {
    records[sessionId] = record
  }
  return JSON.stringify({
    schemaVersion: AGENT_SESSION_STORE_SCHEMA_VERSION,
    hostId: state.hostId,
    records,
    operations: Object.fromEntries(state.operations),
    retiredClaimKeys: state.retiredClaimKeys
  })
}

/** Commit the whole state. The previous file becomes the backup before the new one lands. */
export async function saveAgentSessionStore(
  filePath: string,
  state: AgentSessionStoreState,
  options: { recoveredFromBackup?: boolean } = {}
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = durableWriteTempPath(filePath)
  if (!options.recoveredFromBackup) {
    try {
      await rm(backupPath(filePath), { force: true })
      await rename(filePath, backupPath(filePath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      // First write, or recovery already found the primary missing.
    }
  }
  try {
    await writeFileDurable(tmpPath, filePath, serializeState(state))
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {})
    throw error
  }
}
