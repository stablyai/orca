import type { SshManagedServerNodeDownloadBlocked } from '../../shared/ssh-types'
import { isNodeDistMirrorAttempt } from '../../shared/node-dist-mirror'
import { isSftpSessionClosedError } from './ssh-file-transfer-abort'

// Bounds a failure's detail; the host log tail inside it is already capped.
const MAX_FAILURE_DETAIL_CHARS = 16_000

export type SetupFailure = {
  detail: string
  /** Contact was lost mid-setup: nothing proves the host failed, so it is never called a failure. */
  contactLost?: true
  nodeDownloadBlocked?: SshManagedServerNodeDownloadBlocked
}

export function setupFailure(failure: unknown): SetupFailure {
  return {
    detail: failure instanceof Error ? failure.message : String(failure),
    ...(lostContact(failure) ? { contactLost: true as const } : {}),
    ...nodeDownloadBlocked(failure)
  }
}

export function boundedDetail(text: string): string {
  return text.length > MAX_FAILURE_DETAIL_CHARS ? `…${text.slice(-MAX_FAILURE_DETAIL_CHARS)}` : text
}

// Inspect structured names through wrapped causes without importing download implementation.
function nodeDownloadBlocked(
  failure: unknown,
  depth = 0
): { nodeDownloadBlocked?: SshManagedServerNodeDownloadBlocked } {
  if (failure instanceof Error && failure.name === 'NodeRuntimeUnreachableError') {
    const mirror = 'mirror' in failure ? failure.mirror : undefined
    return { nodeDownloadBlocked: { mirror: isNodeDistMirrorAttempt(mirror) ? mirror : 'tried' } }
  }
  return depth < 4 && failure instanceof Error ? nodeDownloadBlocked(failure.cause, depth + 1) : {}
}

// Only lost session/open contact qualifies; host busy/deadline replies are actual answers. Follow wrapped install causes.
function lostContact(failure: unknown, depth = 0): boolean {
  if (
    isSftpSessionClosedError(failure) ||
    (failure instanceof Error && failure.name === 'SshChannelOpenTimeoutError')
  ) {
    return true
  }
  return depth < 4 && failure instanceof Error && lostContact(failure.cause, depth + 1)
}
