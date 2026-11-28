export type ProfileStateDatabaseOpenErrorCode =
  | 'unreadable'
  | 'identity-mismatch'
  | 'invalid-profile-id'
  | 'newer-schema'

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

const DAMAGED_DATABASE_CODE = 'profile-state-database-damaged'
// SQLITE_CORRUPT and SQLITE_NOTADB; the low byte is the primary result code.
const DAMAGED_SQLITE_RESULT_CODES = new Set([11, 26])

/** A failed integrity check or an unknown schema; reopening cannot repair it. */
export function damagedProfileStateDatabaseError(message: string): Error {
  return Object.assign(new Error(message), { code: DAMAGED_DATABASE_CODE })
}

/** Damage, unlike a held lock or a full disk, survives every later open. */
export function isDamagedProfileStateDatabase(error: ProfileStateDatabaseOpenError): boolean {
  const { cause } = error
  if (typeof cause !== 'object' || cause === null) {
    return false
  }
  if ('code' in cause && cause.code === DAMAGED_DATABASE_CODE) {
    return true
  }
  return (
    'errcode' in cause &&
    typeof cause.errcode === 'number' &&
    DAMAGED_SQLITE_RESULT_CODES.has(cause.errcode & 0xff)
  )
}
