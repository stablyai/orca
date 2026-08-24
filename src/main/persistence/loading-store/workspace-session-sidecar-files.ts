// Atomic workspace-session partition file format, recovery, and backup helpers.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { normalizeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceSessionSalvaging } from '../../../shared/workspace-session-salvage'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  durableWriteTempPath,
  writeFileDurable,
  writeFileDurableSync
} from '../../durable-file-write'

export const PARTITION_SCHEMA_VERSION = 1
const BACKUP_COUNT = 2
export const SAVE_DEBOUNCE_MS = 1_000
export const SAVE_MAX_WAIT_MS = 5_000

export type WorkspaceSessionPartitionEnvelope = {
  schemaVersion: typeof PARTITION_SCHEMA_VERSION
  hostId: ExecutionHostId
  writeGeneration: number
  writtenAt: number
  lastSynchronizedCoreHash?: string
  session: WorkspaceSessionState
}

export type WorkspaceSessionPartitionWriteTrigger =
  | 'patch'
  | 'replace'
  | 'prune'
  | 'pty-binding'
  | 'snapshot'
  | 'migration'
  | 'flush'
  | 'quit'
  | 'profile-transfer'

export type WorkspaceSessionPartitionTrace = {
  hostId: ExecutionHostId
  partitionBytes: number
  durationMs: number
  trigger: WorkspaceSessionPartitionWriteTrigger
  writeGeneration: number
  committed: boolean
}

export type WorkspaceSessionSidecarOptions = {
  onTrace?: (trace: WorkspaceSessionPartitionTrace) => void
  serialize?: (value: unknown) => string
  now?: () => number
}

export type LoadedPartition = {
  envelope: WorkspaceSessionPartitionEnvelope
  recovered: boolean
  repaired: boolean
}

export type LoadResolution = {
  workspaceSession: WorkspaceSessionState
  workspaceSessionsByHostId: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
}

export type DirtyPartition = {
  trigger: WorkspaceSessionPartitionWriteTrigger
  migration: boolean
}

function partitionDirectory(dataFile: string): string {
  const extension = extname(dataFile)
  const stem = basename(dataFile, extension)
  return join(dirname(dataFile), `${stem}-workspace-sessions`)
}

export function getWorkspaceSessionPartitionFile(
  dataFile: string,
  hostId: ExecutionHostId
): string {
  return join(partitionDirectory(dataFile), `${encodeURIComponent(hostId)}.json`)
}

function backupPath(partitionFile: string, index: number): string {
  return `${partitionFile}.bak.${index}`
}
function hostIdFromPartitionFilename(filename: string): ExecutionHostId | null {
  const jsonSuffixIndex = filename.indexOf('.json')
  if (jsonSuffixIndex === -1) {
    return null
  }
  const suffix = filename.slice(jsonSuffixIndex)
  if (suffix !== '.json' && !/^\.json\.bak\.[0-9]+$/.test(suffix)) {
    return null
  }
  try {
    return normalizeExecutionHostId(decodeURIComponent(filename.slice(0, jsonSuffixIndex)))
  } catch {
    return null
  }
}
export function workspaceSessionHash(session: WorkspaceSessionState): string {
  return createHash('sha256').update(JSON.stringify(session)).digest('hex')
}

function parseEnvelope(raw: string, expectedHostId?: ExecutionHostId): LoadedPartition | null {
  const parsed = JSON.parse(raw) as Partial<WorkspaceSessionPartitionEnvelope>
  const hostId = normalizeExecutionHostId(parsed.hostId)
  if (
    parsed.schemaVersion !== PARTITION_SCHEMA_VERSION ||
    !hostId ||
    (expectedHostId !== undefined && hostId !== expectedHostId) ||
    !Number.isSafeInteger(parsed.writeGeneration) ||
    (parsed.writeGeneration ?? -1) < 0 ||
    typeof parsed.writtenAt !== 'number' ||
    !Number.isFinite(parsed.writtenAt)
  ) {
    return null
  }
  const session = parseWorkspaceSessionSalvaging(parsed.session)
  if (!session.ok) {
    return null
  }
  const normalizedSession = { ...getDefaultWorkspaceSession(), ...session.value }
  return {
    envelope: {
      schemaVersion: PARTITION_SCHEMA_VERSION,
      hostId,
      writeGeneration: parsed.writeGeneration!,
      writtenAt: parsed.writtenAt,
      lastSynchronizedCoreHash:
        typeof parsed.lastSynchronizedCoreHash === 'string'
          ? parsed.lastSynchronizedCoreHash
          : undefined,
      session: normalizedSession
    },
    recovered: false,
    repaired: session.droppedCount > 0 || !isDeepStrictEqual(parsed.session, normalizedSession)
  }
}

function readCandidate(path: string, expectedHostId: ExecutionHostId): LoadedPartition | null {
  try {
    return parseEnvelope(readFileSync(path, 'utf-8'), expectedHostId)
  } catch {
    return null
  }
}

export function readPartitionWithRecovery(
  dataFile: string,
  hostId: ExecutionHostId
): LoadedPartition | null {
  const partitionFile = getWorkspaceSessionPartitionFile(dataFile, hostId)
  const primary = readCandidate(partitionFile, hostId)
  if (primary) {
    return primary
  }
  for (let index = 0; index < BACKUP_COUNT; index += 1) {
    const recovered = readCandidate(backupPath(partitionFile, index), hostId)
    if (!recovered) {
      continue
    }
    try {
      mkdirSync(dirname(partitionFile), { recursive: true })
      writeFileDurableSync(
        durableWriteTempPath(partitionFile),
        partitionFile,
        JSON.stringify(recovered.envelope)
      )
      console.warn(
        `[persistence] Recovered workspace session partition ${hostId} from backup ${index}`
      )
    } catch (error) {
      console.error(`[persistence] Failed to restore workspace session partition ${hostId}:`, error)
    }
    return { ...recovered, recovered: true }
  }
  return null
}

export function listPartitionHostIds(dataFile: string): ExecutionHostId[] {
  try {
    return readdirSync(partitionDirectory(dataFile), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => hostIdFromPartitionFilename(entry.name))
      .filter((hostId): hostId is ExecutionHostId => hostId !== null)
  } catch {
    return []
  }
}
export function isDefaultWorkspaceSession(session: WorkspaceSessionState): boolean {
  return JSON.stringify(session) === JSON.stringify(getDefaultWorkspaceSession())
}

function isValidEnvelopePayload(raw: string, hostId: ExecutionHostId): boolean {
  try {
    return parseEnvelope(raw, hostId) !== null
  } catch {
    return false
  }
}

function rotateBackupsSync(partitionFile: string, hostId: ExecutionHostId): void {
  if (!existsSync(partitionFile)) {
    return
  }
  let primary: string
  try {
    primary = readFileSync(partitionFile, 'utf-8')
  } catch {
    return
  }
  if (!isValidEnvelopePayload(primary, hostId)) {
    return
  }
  const newestBackup = backupPath(partitionFile, 0)
  if (existsSync(newestBackup)) {
    try {
      const previous = readFileSync(newestBackup, 'utf-8')
      if (isValidEnvelopePayload(previous, hostId)) {
        writeFileDurableSync(
          durableWriteTempPath(backupPath(partitionFile, 1)),
          backupPath(partitionFile, 1),
          previous
        )
      }
    } catch {
      // Preserve the current primary even when an older backup cannot rotate.
    }
  }
  writeFileDurableSync(durableWriteTempPath(newestBackup), newestBackup, primary)
}

export async function rotateBackups(partitionFile: string, hostId: ExecutionHostId): Promise<void> {
  let primary: string
  try {
    primary = await readFile(partitionFile, 'utf-8')
  } catch {
    return
  }
  if (!isValidEnvelopePayload(primary, hostId)) {
    return
  }
  const newestBackup = backupPath(partitionFile, 0)
  try {
    const previous = await readFile(newestBackup, 'utf-8')
    if (isValidEnvelopePayload(previous, hostId)) {
      await writeFileDurable(
        durableWriteTempPath(backupPath(partitionFile, 1)),
        backupPath(partitionFile, 1),
        previous
      )
    }
  } catch {
    // A missing/unreadable older backup does not block protecting the current primary.
  }
  await writeFileDurable(durableWriteTempPath(newestBackup), newestBackup, primary)
}

export function writePartitionSync(
  dataFile: string,
  envelope: WorkspaceSessionPartitionEnvelope,
  serialize: (value: unknown) => string
): number {
  const partitionFile = getWorkspaceSessionPartitionFile(dataFile, envelope.hostId)
  mkdirSync(dirname(partitionFile), { recursive: true })
  rotateBackupsSync(partitionFile, envelope.hostId)
  const payload = serialize(envelope)
  writeFileDurableSync(durableWriteTempPath(partitionFile), partitionFile, payload)
  return Buffer.byteLength(payload)
}

export function removePartitionFilesSync(dataFile: string, hostId: ExecutionHostId): void {
  const file = getWorkspaceSessionPartitionFile(dataFile, hostId)
  rmSync(file, { force: true })
  for (let index = 0; index < BACKUP_COUNT; index += 1) {
    rmSync(backupPath(file, index), { force: true })
  }
}
