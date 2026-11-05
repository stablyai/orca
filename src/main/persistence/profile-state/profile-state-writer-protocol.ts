import type { SurfaceKey } from '../../../shared/workspace-surfaces/surface-content'
import type {
  SurfaceStorageRead,
  SurfaceStorageReadResult
} from '../../../shared/workspace-surfaces/surface-storage-read'
import {
  isSurfaceStorageRead,
  isSurfaceStorageReadResult,
  isSurfaceStorageCommand,
  isSurfaceStorageResult
} from '../../workspace-surfaces/surface-storage-validation'
import type { JournalSqlFailure } from '../../native-chat/agent-session-journal/journal-sql-protocol'
import type {
  JournalUnitPacket,
  JournalResultPacket
} from '../../native-chat/agent-session-journal/journal-unit-transfer'
import type { SurfaceJointTransaction } from '../../workspace-surfaces/surface-joint-transaction'
import type { ProfileStateDomainReplacement } from '../loading-store/profile-state-authority'
import { isRecord } from './profile-state-document-validation'
import type {
  SurfaceStorageCommand,
  SurfaceStorageMutation,
  SurfaceStorageResult
} from '../../../shared/workspace-surfaces/surface-storage-command'

export type ProfileStateWriterInitialization = {
  databasePath: string
  profileId: string
  revision: number
}

export type ProfileStateWriterJournalPackets = { id: number; journalPackets: JournalResultPacket[] }

export type ProfileStateWriterCommand =
  | { command: 'stage-surface-journal'; packets: readonly JournalUnitPacket[] | null }
  | { command: 'read-surface'; read: SurfaceStorageRead }
  | { command: 'write-surface'; surface: SurfaceStorageCommand }
  | { command: 'write-surfaces'; surfaces: readonly SurfaceStorageMutation[] }
  | { command: 'write-surface-joint'; transaction: SurfaceJointTransaction }
  | { command: 'write-state'; payload: Uint8Array }
  | {
      command: 'write-complete' | 'write-domains'
      replacements: readonly ProfileStateDomainReplacement[]
    }
  | {
      command: 'write-automation'
      replacements: readonly ProfileStateDomainReplacement[]
      runPayloads: readonly string[]
    }
  | { command: 'assert-revision' | 'close' }
  | { command: 'export-json' | 'export-latest'; targetPath: string }

export type ProfileStateWriterRequest = ProfileStateWriterCommand & { id: number }
export type ProfileStateWriterFailureOutcome = 'known-failure' | 'indeterminate'
export type ProfileStateWriterErrorData = {
  code: string
  message: string
  outcome: ProfileStateWriterFailureOutcome
  expectedRevision?: number
  actualRevision?: number
  journal?: JournalSqlFailure
  domain?: string | null
  /** Preserve SQLite causes that the outer open-error class cannot identify. */
  cause?: { code?: string; errcode?: number; message: string }
}
export type ProfileStateWriterResponse =
  | {
      id: number
      ok: true
      revision: number
      exportedRevision?: number | null
      surfaceInvalidations?: readonly SurfaceKey[]
      surfaceRead?: SurfaceStorageReadResult
      surfaceResult?: SurfaceStorageResult
      surfaceResults?: SurfaceStorageResult[]
    }
  | { id: number; ok: false; error: ProfileStateWriterErrorData }

export function isProfileStateRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isProfileStateWriterInitialization(
  value: unknown
): value is ProfileStateWriterInitialization {
  return (
    isRecord(value) &&
    typeof value.databasePath === 'string' &&
    value.databasePath.length > 0 &&
    typeof value.profileId === 'string' &&
    value.profileId.length > 0 &&
    isProfileStateRevision(value.revision)
  )
}

function isReplacement(value: unknown): value is ProfileStateDomainReplacement {
  return (
    isRecord(value) &&
    typeof value.domain === 'string' &&
    value.domain.length > 0 &&
    (typeof value.payload === 'string' || value.payload === null)
  )
}

export function isProfileStateWriterRequest(value: unknown): value is ProfileStateWriterRequest {
  if (!isRecord(value) || !isProfileStateRevision(value.id) || value.id === 0) {
    return false
  }
  switch (value.command) {
    case 'stage-surface-journal':
      return value.packets === null || Array.isArray(value.packets)
    case 'write-surface-joint':
      return (
        isRecord(value.transaction) &&
        typeof value.transaction.journalPath === 'string' &&
        value.transaction.journalPath.length > 0 &&
        Array.isArray(value.transaction.commands) &&
        value.transaction.commands.length > 0 &&
        (value.transaction.effectCount === undefined ||
          isProfileStateRevision(value.transaction.effectCount)) &&
        value.transaction.commands.every(
          (command: unknown) => isSurfaceStorageCommand(command) && command.type !== 'query'
        )
      )
    case 'write-surfaces':
      return (
        Array.isArray(value.surfaces) &&
        value.surfaces.length > 0 &&
        value.surfaces.every(
          (surface: unknown) => isSurfaceStorageCommand(surface) && surface.type !== 'query'
        )
      )
    case 'read-surface':
      return isSurfaceStorageRead(value.read)
    case 'write-surface':
      return isSurfaceStorageCommand(value.surface)
    case 'write-state':
      return value.payload instanceof Uint8Array
    case 'assert-revision':
    case 'close':
      return true
    case 'export-json':
    case 'export-latest':
      return typeof value.targetPath === 'string' && value.targetPath.length > 0
    case 'write-complete':
    case 'write-domains':
      return Array.isArray(value.replacements) && value.replacements.every(isReplacement)
    case 'write-automation':
      return (
        Array.isArray(value.replacements) &&
        value.replacements.every(isReplacement) &&
        Array.isArray(value.runPayloads) &&
        value.runPayloads.every((payload: unknown) => typeof payload === 'string')
      )
    default:
      return false
  }
}

function isErrorData(value: unknown): value is ProfileStateWriterErrorData {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    (value.outcome === 'known-failure' || value.outcome === 'indeterminate') &&
    (value.expectedRevision === undefined || isProfileStateRevision(value.expectedRevision)) &&
    (value.actualRevision === undefined || isProfileStateRevision(value.actualRevision)) &&
    (value.domain === undefined || value.domain === null || typeof value.domain === 'string') &&
    (value.cause === undefined || isErrorCauseData(value.cause))
  )
}

function isErrorCauseData(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.message === 'string' &&
    (value.code === undefined || typeof value.code === 'string') &&
    (value.errcode === undefined || typeof value.errcode === 'number')
  )
}

export function isProfileStateWriterResponse(value: unknown): value is ProfileStateWriterResponse {
  if (!isRecord(value) || !isProfileStateRevision(value.id)) {
    return false
  }
  return value.ok === true
    ? isProfileStateRevision(value.revision) &&
        (value.surfaceRead === undefined || isSurfaceStorageReadResult(value.surfaceRead)) &&
        (value.surfaceInvalidations === undefined ||
          (Array.isArray(value.surfaceInvalidations) &&
            value.surfaceInvalidations.every(
              (key) =>
                isRecord(key) &&
                typeof key.hostId === 'string' &&
                typeof key.workspaceId === 'string' &&
                typeof key.hostTabId === 'string'
            ))) &&
        (value.surfaceResult === undefined || isSurfaceStorageResult(value.surfaceResult)) &&
        (value.surfaceResults === undefined ||
          (Array.isArray(value.surfaceResults) &&
            value.surfaceResults.every(isSurfaceStorageResult))) &&
        (value.exportedRevision === undefined ||
          value.exportedRevision === null ||
          isProfileStateRevision(value.exportedRevision))
    : value.ok === false && isErrorData(value.error)
}
