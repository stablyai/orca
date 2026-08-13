export {
  SSH_SESSION_EXPIRED_ERROR,
  SSH_PTY_IDENTITY_MISMATCH_ERROR,
  SSH_PTY_EXITED_ERROR,
  SSH_SOURCE_RESTORE_REQUIRED_ERROR
} from '../../shared/ssh-pty-failure-tokens'
import {
  SSH_SOURCE_RESTORE_REQUIRED_ERROR,
  isSshPtyExitedMessage,
  isSshPtyIdentityMismatchMessage
} from '../../shared/ssh-pty-failure-tokens'

export function isSshSourceRestoreRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(SSH_SOURCE_RESTORE_REQUIRED_ERROR)
}

export function isSshPtyNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /PTY ".+" not found/i.test(message)
}

/** The relay watched this shell exit — first-hand proof, unlike a bare not-found. */
export function isSshPtyExitedError(error: unknown): boolean {
  return isSshPtyExitedMessage(error instanceof Error ? error.message : String(error))
}

export function isSshPtyIdentityMismatchError(error: unknown): boolean {
  return isSshPtyIdentityMismatchMessage(error instanceof Error ? error.message : String(error))
}
