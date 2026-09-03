export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
export const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'
/**
 * The relay accepted the attach for a PTY it had just proven alive and only retired the stale
 * output delivery. Deliberately not `SSH_SESSION_EXPIRED`: every consumer of that token retires the
 * pane binding and cold-restores the agent, which duplicates a running agent onto one transcript
 * (docs/reference/ssh-execution-boundary.md — respawning needs host evidence of absence, and this
 * reply is host evidence of the opposite).
 */
export const SSH_PTY_SOURCE_RESTORE_REQUIRED_ERROR = 'SSH_PTY_SOURCE_RESTORE_REQUIRED'

export function isSshPtyNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /PTY ".+" not found/i.test(message)
}

export function isSshPtyIdentityMismatchError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR) || /identity mismatch/i.test(message)
}

/**
 * A reachable relay answered for this exact PTY id and reported it absent — positive evidence of
 * absence from the execution host, so `exited` rather than `unverifiable`
 * (docs/reference/ssh-execution-boundary.md). Deliberately NOT raised for a transport failure, a
 * request timeout, a disposed multiplexer, an identity mismatch (the id names a live PTY belonging
 * to another pane), or `restoreRequired` (the PTY is live, only its source stream is not) — none of
 * those observe the process, and treating them as absence orphans live remote work.
 *
 * Carries the same `SSH_SESSION_EXPIRED` message so message-based consumers are unaffected; only
 * callers that can act on the stronger verdict test the class.
 */
export class SshPtyAbsentFromRelayError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshPtyAbsentFromRelayError'
  }
}

export function isSshPtyAbsentFromRelayError(error: unknown): boolean {
  return error instanceof SshPtyAbsentFromRelayError
}
