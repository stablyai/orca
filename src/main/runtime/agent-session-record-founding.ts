import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'

/** Who a conversation's agent is and how it launches: the same whether it is created or founded. */
export type AgentSessionRecordIdentity = Pick<
  AgentSessionRecord,
  'sessionId' | 'location' | 'provider' | 'accountHome' | 'options' | 'launchArgs'
>

export function agentSessionRecordIdentityFields(
  identity: AgentSessionRecordIdentity,
  now: number
) {
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: identity.sessionId,
    location: identity.location,
    provider: identity.provider,
    accountHome: identity.accountHome,
    ...(identity.options ? { options: { ...identity.options } } : {}),
    ...(identity.launchArgs ? { launchArgs: [...identity.launchArgs] } : {}),
    createdAt: now,
    updatedAt: now
  }
}

/**
 * A conversation no agent has run yet, at rest: its first send starts one. An empty handle chain
 * makes that start a fresh conversation; an adopted link makes it a resume.
 */
export function foundAgentSessionRecord(
  identity: AgentSessionRecordIdentity,
  lease: { claimKeyId: string; now: number },
  /** The provider conversation a create adopts; its first start resumes it instead. */
  adoptedHandleLink?: AgentSessionProviderHandleLink
): AgentSessionRecord {
  return {
    ...agentSessionRecordIdentityFields(identity, lease.now),
    providerHandleChain: adoptedHandleLink ? [adoptedHandleLink] : [],
    lease: {
      sessionId: identity.sessionId,
      runtimeKind: 'native',
      // Not 0: clients echo the fence as their expected fence, which the wire requires positive.
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: lease.now,
      lastRenewedAt: lease.now,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: lease.claimKeyId,
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    }
  }
}
