import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import { providerChildRootExited } from './structured-agent-session-provider-child'

export function structuredAgentSessionModelCatalogScope(
  sessionId: string,
  record: AgentSessionRecord | null | undefined,
  session: Pick<StructuredAgentSessionHostSession, 'child' | 'lastEndedChild'> | undefined
): string | null {
  if (!record || record.provider === 'codex') {
    return null
  }
  if (providerChildRootExited(session, record.lease.runtimeFence)) {
    return null
  }
  const child =
    session?.child ?? (session?.lastEndedChild?.rootGone === false ? session.lastEndedChild : null)
  const launch = [record.provider, record.accountHome, record.location, record.launchDirectory]
  if (child) {
    return JSON.stringify([sessionId, child.generation, child.fence, launch])
  }
  const lease = record.lease
  return lease &&
    !lease.deathEvidence &&
    (lease.claimStatus !== 'released' || lease.ownerProcess !== null)
    ? JSON.stringify([sessionId, 'unverifiable', lease.runtimeFence, launch])
    : null
}
