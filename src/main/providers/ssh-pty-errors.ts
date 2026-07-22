export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
export const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'

export function isSshPtyNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /PTY ".+" not found/i.test(message)
}

export function isSshPtyIdentityMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR) || /identity mismatch/i.test(message)
}
