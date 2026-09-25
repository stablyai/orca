import {
  ProfileStateDocumentCorruptionError,
  ProfileStateRevisionConflictError
} from './profile-state-document-validation'
import { ProfileStateDatabaseOpenError } from './profile-state-database-errors'
import { ProfileStateIndeterminateWriteError } from './profile-state-write-transaction'
import { ProfileStateReadRollbackError } from './profile-state-read-snapshot'
import type {
  ProfileStateWriterErrorData,
  ProfileStateWriterFailureOutcome
} from './profile-state-writer-protocol'

export class ProfileStateWriterError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: ProfileStateWriterFailureOutcome,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'ProfileStateWriterError'
  }
}

export function profileStateWriterFailureOutcome(error: unknown): ProfileStateWriterFailureOutcome {
  if (
    error instanceof ProfileStateIndeterminateWriteError ||
    error instanceof ProfileStateReadRollbackError
  ) {
    return 'indeterminate'
  }
  if (error instanceof ProfileStateWriterError) {
    return error.outcome
  }
  if (error instanceof Error && error.cause !== undefined) {
    return profileStateWriterFailureOutcome(error.cause)
  }
  return 'known-failure'
}

export function encodeProfileStateWriterError(
  error: unknown,
  forceIndeterminate = false
): ProfileStateWriterErrorData {
  const outcome = forceIndeterminate ? 'indeterminate' : profileStateWriterFailureOutcome(error)
  if (error instanceof ProfileStateRevisionConflictError) {
    return {
      code: error.code,
      message: error.message,
      outcome,
      expectedRevision: error.expectedRevision,
      actualRevision: error.actualRevision
    }
  }
  if (error instanceof ProfileStateDocumentCorruptionError) {
    return { code: error.code, message: error.message, outcome, domain: error.domain }
  }
  if (
    error instanceof ProfileStateDatabaseOpenError ||
    error instanceof ProfileStateWriterError ||
    error instanceof ProfileStateIndeterminateWriteError ||
    error instanceof ProfileStateReadRollbackError
  ) {
    return { code: error.code, message: error.message, outcome }
  }
  return {
    code: 'profile-state-write-failed',
    message: 'Profile state persistence failed',
    outcome
  }
}

export function decodeProfileStateWriterError(data: ProfileStateWriterErrorData): Error {
  if (data.outcome === 'known-failure') {
    if (
      data.code === 'profile-state-revision-conflict' &&
      data.expectedRevision !== undefined &&
      data.actualRevision !== undefined
    ) {
      return new ProfileStateRevisionConflictError(data.expectedRevision, data.actualRevision)
    }
    if (data.code === 'corrupt-document') {
      return new ProfileStateDocumentCorruptionError(data.message, data.domain ?? null)
    }
    if (
      data.code === 'unreadable' ||
      data.code === 'identity-mismatch' ||
      data.code === 'invalid-profile-id'
    ) {
      return new ProfileStateDatabaseOpenError(data.code, data.message)
    }
  }
  return new ProfileStateWriterError(data.code, data.message, data.outcome)
}
