/** What a managed-server setup that stopped short shows under its SSH host. */
import { isSftpSessionClosedError } from './ssh-file-transfer-abort'

// Bounds a failure's detail; the host log tail inside it is already capped.
const MAX_FAILURE_DETAIL_CHARS = 16_000

export type SetupFailure = {
  detail: string
  /** Contact was lost mid-setup: nothing proves the host failed, so it is never called a failure. */
  contactLost?: true
}

export function setupFailure(failure: unknown): SetupFailure {
  return {
    detail: failure instanceof Error ? failure.message : String(failure),
    ...(lostContact(failure) ? { contactLost: true as const } : {})
  }
}

export function boundedDetail(text: string): string {
  return text.length > MAX_FAILURE_DETAIL_CHARS ? `…${text.slice(-MAX_FAILURE_DETAIL_CHARS)}` : text
}

// Why only a closed session or an unanswered channel open: other unconfirmed results (a host's
// busy or deadline answer) came from a host that answered. Why the cause chain: install steps wrap
// the transport error they hit.
function lostContact(failure: unknown, depth = 0): boolean {
  if (
    isSftpSessionClosedError(failure) ||
    (failure instanceof Error && failure.name === 'SshChannelOpenTimeoutError')
  ) {
    return true
  }
  return depth < 4 && failure instanceof Error && lostContact(failure.cause, depth + 1)
}
