export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
export const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'

export function isSshPtyNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /PTY ".+" not found/i.test(message)
}

export function isSshPtyIdentityMismatchError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR) || /identity mismatch/i.test(message)
}
