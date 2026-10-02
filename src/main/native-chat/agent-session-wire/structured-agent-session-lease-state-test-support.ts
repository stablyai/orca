// A partial test host's `leaseState`: the derivation over its records, with the host running the
// owner of each live lease `runs` names (all of them unless told otherwise), and probing nothing.

import {
  agentSessionLeaseAdmitsWriter,
  deriveAgentSessionLeaseState,
  type AgentSessionLeaseState
} from '../../../shared/agent-session-lease-state'
import type { AgentSessionLease, AgentSessionRecord } from '../../../shared/agent-session-record'
import { agentSessionLeaseFixture } from '../../../shared/agent-session-record.test-fixture'
import type { StructuredAgentSessionHostMemory } from './structured-agent-session-host-runtime-state'

export function testHostLeaseState(
  /** A fixture's record reader; partial records carry at least the lease fields they assert on. */
  getRecord: (sessionId: string) => unknown,
  runs: (sessionId: string) => boolean = () => true
): (sessionId: string) => AgentSessionLeaseState | null {
  return (sessionId) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixtures pass records, often partial; the missing lease fields are completed below.
    const record = getRecord(sessionId) as Pick<AgentSessionRecord, 'lease'> | null | undefined
    if (!record) {
      return null
    }
    const lease = completeFixtureLease(record.lease)
    return deriveAgentSessionLeaseState(lease, {
      fence: lease.runtimeFence,
      attemptInFlight: false,
      owner:
        lease.claimStatus === 'live' && lease.ownerProcess !== null && runs(sessionId)
          ? { kind: 'runs' }
          : { kind: 'none' }
    })
  }
}

const FIXTURE_OWNER = { hostId: 'local', pid: 4242, processStartTimeMs: null, spawnToken: 'spawn' }

/** Many fixtures build only the lease fields they assert on; the rest read as a settled lease. */
function completeFixtureLease(partial: Partial<AgentSessionLease>): AgentSessionLease {
  return {
    ...agentSessionLeaseFixture({ sessionId: 'session-fixture', runtimeKind: 'native' }),
    unreconciled: false,
    handoffStage: null,
    deathEvidence: null,
    ...(partial.claimStatus === 'released'
      ? { ownerProcess: null, reservedSpawnToken: null }
      : { ownerProcess: FIXTURE_OWNER }),
    ...partial
  }
}

/** `performAttach`'s `ownerAdmitted` for a test with no host: every live owner runs here. */
export function testOwnerAdmitted(record: AgentSessionRecord): boolean {
  const state = testHostLeaseState(() => record)(record.sessionId)
  return state !== null && agentSessionLeaseAdmitsWriter(state)
}

/** Runtime-state memory for a test with no conversations: nothing running, nothing serialized. */
export const NO_HOST_MEMORY: StructuredAgentSessionHostMemory = {
  session: () => undefined,
  serialize: (_sessionId, task) => task()
}
