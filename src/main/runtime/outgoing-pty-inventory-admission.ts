import {
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { getPtyExecutionHost } from '../../shared/terminal-execution-host'
import { isOutgoingPtyRegistrationFenced } from './outgoing-pty-registration-fence'

export function includeListedSshInventoryHosts(
  sessions: readonly { id: string }[],
  hostIds: Set<ExecutionHostId>
): void {
  for (const session of sessions) {
    const hostId = getPtyExecutionHost(session.id)
    if (hostId && hostId !== 'foreign' && parseExecutionHostId(hostId)?.kind === 'ssh') {
      hostIds.add(hostId)
    }
  }
}

/** A census touching held source records is unavailable, not evidence of absence. */
export function isOutgoingPtyInventoryFenced(
  runtime: object,
  sessions: readonly { id: string }[],
  tracked: Iterable<{ ptyId: string; connectionId: string | null }>,
  queriedHostIds: ReadonlySet<ExecutionHostId>
): boolean {
  if (sessions.some((session) => isOutgoingPtyRegistrationFenced(runtime, session.id))) {
    return true
  }
  for (const pty of tracked) {
    const target = parseAppSshPtyId(pty.ptyId)?.connectionId ?? pty.connectionId
    if (
      isOutgoingPtyRegistrationFenced(runtime, pty.ptyId) &&
      target &&
      queriedHostIds.has(toSshExecutionHostId(target))
    ) {
      return true
    }
  }
  return false
}
