import { onProcessTableCapture } from '../../shared/process-table-capture-observers'
import { observeSessionDescendantGroups } from '../pty-session-identity'
import type { Session } from './session'

/**
 * Keeps every live session's process-group membership current from captures
 * Orca already takes for foreground-process evidence.
 *
 * Why not a poll of its own: a shell's job groups are only discoverable while
 * the job's ancestry is intact, and by teardown that ancestry is gone. Riding
 * the existing captures buys that observation for no extra `ps`.
 */
export function observeLiveSessionProcessIdentities(
  sessions: ReadonlyMap<string, Pick<Session, 'isAlive' | 'processIdentity'>>
): () => void {
  return onProcessTableCapture((rows, capturedAtMs) => {
    for (const session of sessions.values()) {
      if (session.isAlive) {
        observeSessionDescendantGroups(session.processIdentity, rows, capturedAtMs)
      }
    }
  })
}
