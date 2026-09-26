import type { ProfileStateDomainReplacement } from '../loading-store/profile-state-authority'
import { isRecord } from './profile-state-document-validation'

export type ProfileStateWriterInitialization = {
  databasePath: string
  profileId: string
  revision: number
}

export type ProfileStateWriterCommand =
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
  | { command: 'export-json' | 'export-latest' | 'export-compatibility'; targetPath: string }

export type ProfileStateWriterRequest = ProfileStateWriterCommand & { id: number }
export type ProfileStateWriterFailureOutcome = 'known-failure' | 'indeterminate'
export type ProfileStateWriterErrorData = {
  code: string
  message: string
  outcome: ProfileStateWriterFailureOutcome
  expectedRevision?: number
  actualRevision?: number
  domain?: string | null
}
export type ProfileStateWriterResponse =
  | { id: number; ok: true; revision: number; exportedRevision?: number | null }
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
    case 'write-state':
      return value.payload instanceof Uint8Array
    case 'assert-revision':
    case 'close':
      return true
    case 'export-json':
    case 'export-latest':
    case 'export-compatibility':
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
    (value.domain === undefined || value.domain === null || typeof value.domain === 'string')
  )
}

export function isProfileStateWriterResponse(value: unknown): value is ProfileStateWriterResponse {
  if (!isRecord(value) || !isProfileStateRevision(value.id)) {
    return false
  }
  return value.ok === true
    ? isProfileStateRevision(value.revision) &&
        (value.exportedRevision === undefined ||
          value.exportedRevision === null ||
          isProfileStateRevision(value.exportedRevision))
    : value.ok === false && isErrorData(value.error)
}
