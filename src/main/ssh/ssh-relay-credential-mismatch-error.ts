// Why: the remote --connect exits with this code after the daemon refused its endpoint
// credential. The mapping daemon ⇄ exit code 43 lives in src/relay/relay-handshake.ts
// (EXIT_CODE_CREDENTIAL_MISMATCH). Bridges older than that constant exit 1 instead, so the
// absence of 43 proves nothing; only its presence is evidence.
export const RELAY_EXIT_CODE_CREDENTIAL_MISMATCH = 43

/**
 * A live daemon answered the handshake and refused the credential the client read from disk.
 * Positive host evidence that the endpoint is held, on any host — no `lsof` required.
 */
export class RelayCredentialMismatchError extends Error {
  readonly name = 'RelayCredentialMismatchError'

  constructor(readonly stderr?: string) {
    super(
      'The remote relay refused this connection: the endpoint credential on disk does not match ' +
        'the one the running relay holds. Orca will not replace that relay while it holds terminals.'
    )
  }
}

export function isRelayCredentialMismatchError(err: unknown): err is RelayCredentialMismatchError {
  return err instanceof RelayCredentialMismatchError
}
