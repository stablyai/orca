import {
  AGENT_SESSION_FOUNDING_FENCE,
  agentSessionNeverStarted
} from '../../shared/agent-session-conversation-view'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../shared/agent-chat-permission-mode'
import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionRecord
} from '../../shared/agent-session-record'

export type AgentSessionRecordIdentity = Pick<
  AgentSessionRecord,
  | 'sessionId'
  | 'location'
  | 'provider'
  | 'accountHome'
  | 'options'
  | 'launchArgs'
  | 'launchDirectory'
>

export function agentSessionRecordIdentityFields(
  identity: AgentSessionRecordIdentity,
  now: number
) {
  // Wire options carry permission mode; records store it separately.
  const { [AGENT_CHAT_PERMISSION_MODE_OPTION_ID]: permissionMode, ...options } =
    identity.options ?? {}
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    sessionId: identity.sessionId,
    location: identity.location,
    provider: identity.provider,
    accountHome: identity.accountHome,
    ...(Object.keys(options).length > 0 ? { options } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(identity.launchArgs ? { launchArgs: [...identity.launchArgs] } : {}),
    // /clear retains its tab and launch directory.
    ...(identity.launchDirectory ? { launchDirectory: identity.launchDirectory } : {}),
    createdAt: now,
    updatedAt: now
  }
}

/** No reservation, owner or provider handle means no agent ever started. */
export const structuredSessionNeverStarted = agentSessionNeverStarted

/** An empty handle chain starts a fresh conversation on first send rather than resuming one. */
export function foundAgentSessionRecord(
  identity: AgentSessionRecordIdentity,
  lease: { claimKeyId: string; now: number }
): AgentSessionRecord {
  return {
    ...agentSessionRecordIdentityFields(identity, lease.now),
    providerHandleChain: [],
    lease: {
      sessionId: identity.sessionId,
      runtimeKind: 'native',
      // Wire expected fences must be positive; zero cannot represent a founded record.
      runtimeFence: AGENT_SESSION_FOUNDING_FENCE,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: lease.now,
      lastRenewedAt: lease.now,
      handoffOperationId: null,
      claimKeyId: lease.claimKeyId,
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    }
  }
}
