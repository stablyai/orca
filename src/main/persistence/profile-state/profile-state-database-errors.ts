export type ProfileStateDatabaseOpenErrorCode =
  | 'unreadable'
  | 'identity-mismatch'
  | 'invalid-profile-id'

export class ProfileStateDatabaseOpenError extends Error {
  readonly code: ProfileStateDatabaseOpenErrorCode
  readonly cause: unknown

  constructor(code: ProfileStateDatabaseOpenErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'ProfileStateDatabaseOpenError'
    this.code = code
    this.cause = cause
  }
}
