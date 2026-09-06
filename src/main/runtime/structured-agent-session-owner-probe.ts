import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import {
  probeAgentSessionProcessIdentities,
  probeAgentSessionProcessIdentity,
  probeAgentSessionReservation
} from './agent-session-process-identity-probe'
import { findAgentSessionSpawnTokenProcesses } from './agent-session-spawn-token-process-scan'
import { readEchoedAgentSessionSpawnToken } from './agent-session-spawn-token-readback'

/**
 * The lease's only source of truth about a previous owner. Everything it cannot
 * answer PID-reuse-safely reports `indeterminate`. An exact owner stays fenced in `recovering`;
 * an ownerless, unattributable reservation enters `manual-recovery`.
 */
export function createStructuredAgentSessionOwnerProbe(
  hostId: string,
  probe = probeAgentSessionProcessIdentity,
  findSpawnTokenProcesses = findAgentSessionSpawnTokenProcesses
): (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe> {
  return async (record) => {
    const owner = record.lease.ownerProcess
    if (!owner) {
      if (record.lease.processlessAt !== undefined && record.lease.processlessAt !== null) {
        return { outcome: 'reservation-unused' }
      }
      const spawnToken = record.lease.reservedSpawnToken
      if (spawnToken === null) {
        if (record.lease.claimStatus === 'reserved') {
          return {
            outcome: 'indeterminate',
            reason: 'reservation recorded no spawn token to scan for'
          }
        }
        // The token is minted before the child and is the only thing a child could be carrying.
        // No owner and no token means nothing on any host can be holding this lease — answering
        // `indeterminate` here is what latches an already-free record into recovery forever.
        return { outcome: 'reservation-unused' }
      }
      // Freeing a reservation needs positive proof that nothing spawned under its token. The scan
      // answers null where the platform cannot read another process's environment.
      return probeAgentSessionReservation({
        spawnToken,
        findProcessesWithSpawnToken: (token) => findSpawnTokenProcesses(token),
        hasProviderActivitySinceReservation: async () =>
          agentSessionReservationTouchedProvider(record)
      })
    }
    if (owner.hostId !== hostId) {
      // Checking a remote host's pid against this machine's process table is
      // exactly how a live owner gets declared dead.
      return {
        outcome: 'indeterminate',
        reason: `owner runs on ${owner.hostId}, which this host cannot probe`
      }
    }
    // The env read-back answers on hosts that expose it and null elsewhere, giving the
    // probe a PID-reuse-safe element even when no start time was recorded.
    return probe({
      identity: owner,
      deps: { readEchoedSpawnToken: readEchoedAgentSessionSpawnToken }
    })
  }
}

export function createStructuredAgentSessionOwnerProbes(
  hostId: string,
  probeMany: typeof probeAgentSessionProcessIdentities = probeAgentSessionProcessIdentities,
  probeOne = createStructuredAgentSessionOwnerProbe(hostId)
): (records: readonly AgentSessionRecord[]) => Promise<Map<string, AgentSessionOwnerProbe>> {
  return async (records) => {
    const results = new Map<string, AgentSessionOwnerProbe>()
    const localOwners: {
      record: AgentSessionRecord
      owner: NonNullable<AgentSessionRecord['lease']['ownerProcess']>
    }[] = []
    for (const record of records) {
      const owner = record.lease.ownerProcess
      if (owner?.hostId === hostId) {
        localOwners.push({ record, owner })
      } else {
        results.set(record.sessionId, await probeOne(record))
      }
    }
    const probes = await probeMany({
      identities: localOwners.map(({ owner }) => owner),
      deps: { readEchoedSpawnToken: readEchoedAgentSessionSpawnToken }
    })
    for (const [index, { record }] of localOwners.entries()) {
      results.set(
        record.sessionId,
        probes[index] ?? { outcome: 'indeterminate', reason: 'owner probe returned no result' }
      )
    }
    return results
  }
}

/**
 * The only provider-side trace a reservation can leave in its own record: a handle link minted at
 * this fence. `proveAgentSessionOwner` refuses to append one before an identity is committed, so a
 * link at the reservation's fence means a child got far enough to resume the provider thread. It
 * cannot see activity the child produced without proving a handle, which is why it is paired with
 * the token scan rather than trusted alone.
 */
function agentSessionReservationTouchedProvider(record: AgentSessionRecord): boolean {
  return record.providerHandleChain.at(-1)?.mintedAtFence === record.lease.runtimeFence
}
