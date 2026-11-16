// Treat --connect exit 42 as terminal version refusal: skip transport backoff and ask for manual reconnect. See docs/ssh-relay-versioned-install-dirs.md.

export class RelayVersionMismatchError extends Error {
  readonly name = 'RelayVersionMismatchError'

  constructor(
    readonly expected: string | undefined,
    readonly got: string | undefined,
    readonly stderr?: string
  ) {
    super(
      `Remote relay version mismatch — expected=${expected ?? 'unknown'}, ` +
        `daemon=${got ?? 'unknown'}. The remote daemon was launched against a different ` +
        `relay binary than the local client expects. Please reconnect manually.`
    )
  }
}

// relay-handshake.ts maps wire version refusal to exit 42.
export const RELAY_EXIT_CODE_VERSION_MISMATCH = 42
