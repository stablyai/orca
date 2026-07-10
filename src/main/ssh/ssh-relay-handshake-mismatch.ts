import {
  RelayVersionMismatchError,
  RELAY_EXIT_CODE_VERSION_MISMATCH
} from './ssh-relay-version-mismatch-error'

export function buildRelayVersionMismatchError(
  exitCode: number | null,
  stderr: string
): RelayVersionMismatchError | null {
  if (exitCode !== RELAY_EXIT_CODE_VERSION_MISMATCH) {
    return null
  }
  const { expected, got } = parseHandshakeMismatchStderr(stderr)
  return new RelayVersionMismatchError(expected, got, stderr.trim())
}

// Why: extract the expected/got version pair from --connect's stderr line
// "Handshake mismatch: expected=<x>, daemon=<y>" so diagnostics name both versions.
function parseHandshakeMismatchStderr(stderr: string): {
  expected: string | undefined
  got: string | undefined
} {
  const match = /expected=([^,\s]+),\s*daemon=([^\s;]+)/.exec(stderr)
  if (!match) {
    return { expected: undefined, got: undefined }
  }
  return { expected: match[1], got: match[2] }
}
