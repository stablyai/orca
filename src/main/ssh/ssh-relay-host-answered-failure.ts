/**
 * Whether a failed relay-runtime attempt got an answer from the host. An answered failure is a
 * verdict on that rung, so the ladder steps down; an unanswered one says nothing about the host,
 * so the connect fails retryably and never launches a second relay beside one that may be running.
 */
import { isSshCommandExitError } from './ssh-relay-exec-command'
import { isSshSessionLimitError } from './ssh-session-limit-error'
import {
  isHostAnsweredSystemSshExit,
  SystemSshCommandExitError
} from './system-ssh-operation-lifecycle'

/** SFTP statuses the server sent about the request itself; NO_CONNECTION/CONNECTION_LOST are transport. */
const ANSWERED_SFTP_STATUSES: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 8])

/** A host-side step that answered with something other than success, carrying what it said. */
export class RelayHostAnsweredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RelayHostAnsweredError'
  }
}

function isSftpStatusError(err: Error): boolean {
  const code = 'code' in err ? err.code : undefined
  return typeof code === 'number' && ANSWERED_SFTP_STATUSES.has(code)
}

export function isAnsweredHostFailure(err: unknown): boolean {
  if (!(err instanceof Error) || err.name === 'AbortError' || isSshSessionLimitError(err)) {
    return false
  }
  // Why the close check: a channel whose close was never confirmed may still be running.
  if (/channel open failure/i.test(err.message) || 'sshChannelCloseConfirmed' in err) {
    return false
  }
  if (err instanceof SystemSshCommandExitError) {
    return isHostAnsweredSystemSshExit(err)
  }
  return (
    err instanceof RelayHostAnsweredError || isSshCommandExitError(err) || isSftpStatusError(err)
  )
}
