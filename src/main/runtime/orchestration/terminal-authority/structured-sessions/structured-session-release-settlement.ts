/** Release-settlement for a settled Dispatch's structured session: the reconciled lease names
 * nothing that could still run, this host holds none of it, and no listed tab could start it. */

import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredSessionTabRetired } from './structured-worker-custody'
import { structuredWorkerSession } from './structured-worker-authority'

/** Unlike `observeStructuredSession`, this verdict settles a worker's terminal release; it never
 *  feeds restart, custody, or close decisions, where "unverifiable" must stay unverifiable. */
export function structuredSessionReleaseSettled(sessionId: string): boolean {
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return false
  }
  const located = structuredWorkerSession({ sessionId })
  if (located.kind !== 'here') {
    return false
  }
  const record = host.deps.store.getConversation(located.sessionId)
  const lease = record?.ownerObservation
  return Boolean(
    record &&
    !lease?.unreconciled &&
    lease?.claimStatus === 'released' &&
    lease.handoffStage === null &&
    lease.ownerProcess === null &&
    lease.reservedSpawnToken === null &&
    record.providerHandleChain.length === 0 &&
    !host.hasSession(located.sessionId) &&
    structuredSessionTabRetired(host, located.sessionId)
  )
}
