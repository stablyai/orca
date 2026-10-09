// A complete, typed agent-session record for tests that care about a few of its fields.

import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  type AgentSessionExecutionLocation,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

export function agentSessionRecordFixture(
  overrides: Partial<Omit<AgentSessionRecord, 'location'>> & {
    sessionId: string
    location?: Partial<AgentSessionExecutionLocation>
  }
): AgentSessionRecord {
  const { location, ...rest } = overrides
  return {
    schemaVersion: AGENT_SESSION_RECORD_SCHEMA_VERSION,
    provider: 'claude',
    providerHandleChain: [],
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/work/.claude' },
    createdAt: 0,
    updatedAt: 0,
    lease: {
      sessionId: overrides.sessionId,
      runtimeKind: 'native',
      runtimeFence: 1,
      handoffStage: null,
      provenHandleLinkId: null,
      ownerProcess: null,
      reservedSpawnToken: null,
      leaseDeadlineAt: 0,
      lastRenewedAt: 0,
      handoffOperationId: null,
      journalCheckpoint: null,
      claimKeyId: 'test-key',
      claimStatus: 'released',
      unreconciled: false,
      deathEvidence: null
    },
    ...rest,
    location: {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder',
      ...location
    }
  }
}
