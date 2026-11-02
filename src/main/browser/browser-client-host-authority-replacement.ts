import { BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE } from '../../shared/browser-client-host-protocol'

/** Authority replacement preserves live guests for the successor to reclaim. */
export function isBrowserClientHostAuthorityReplaced(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const code = (error as { code?: unknown }).code
  if (code === BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE) {
    return true
  }
  // Older runtimes send the mismatch code as the whole message of a generic error.
  return error.message === BROWSER_CLIENT_HOST_AUTHORITY_MISMATCH_CODE
}
