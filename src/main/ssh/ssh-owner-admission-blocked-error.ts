// Why a typed error instead of raw transport classification: another authenticated connection holds
// the PTY session owner claim, and no relay redeploy or backoff attempt can reconcile that. The
// reconnect ladder has to stop and say what actually happened rather than blame the link.

export class SshOwnerAdmissionBlockedError extends Error {
  readonly name = 'SshOwnerAdmissionBlockedError'

  constructor(targetId: string, options?: { cause?: unknown }) {
    super(
      `Another connection currently owns the remote terminals for ${targetId}. ` +
        `Disconnect that client, or wait for it to release ownership, before reconnecting.`,
      options
    )
  }
}

export function isSshOwnerAdmissionBlockedError(
  err: unknown
): err is SshOwnerAdmissionBlockedError {
  return err instanceof SshOwnerAdmissionBlockedError
}
