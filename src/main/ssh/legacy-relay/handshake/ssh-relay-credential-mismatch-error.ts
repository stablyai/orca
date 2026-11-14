// relay-handshake.ts maps credential refusal to exit 43; older bridges exit 1, so only 43 proves refusal.
export const RELAY_EXIT_CODE_CREDENTIAL_MISMATCH = 43

/** A credential refusal proves a live endpoint on every host, without lsof. */
export class RelayCredentialMismatchError extends Error {
  readonly name = 'RelayCredentialMismatchError'

  constructor(readonly stderr?: string) {
    super(
      'The remote relay refused this connection: the endpoint credential on disk does not match ' +
        'the one the running relay holds. Orca will not replace that relay while it holds terminals.'
    )
  }
}
