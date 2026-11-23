import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  probeAgentSessionProcessIdentities,
  probeAgentSessionProcessIdentity,
  probeAgentSessionReservation
} from './agent-session-process-identity-probe'
import { findAgentSessionSpawnTokenProcesses } from './agent-session-spawn-token-process-scan'
import { readEchoedAgentSessionSpawnToken } from './agent-session-spawn-token-readback'
import {
  keptRunningProviderRelayPid,
  listProviderRelaysAtLaunch
} from '../../../provider-relay/app-provider-relays'
import { providerOwnerHeldElsewhere } from '../../../provider-relay/provider-relay-owner-ancestry'

/**
 * An owner still running under the terminal host is this app's to reattach, not an orphan to stop:
 * it reads as unprovable, which recovery releases without signalling it.
 */
async function keptRunningProbe(
  record: AgentSessionRecord,
  hostId: string
): Promise<AgentSessionOwnerProbe | null> {
  const owner = record.lease.ownerProcess
  if (!owner) {
    return null
  }
  await listProviderRelaysAtLaunch()
  // The inventory may have missed a daemon that was slow to answer; the process tree can't.
  const kept =
    keptRunningProviderRelayPid(record.sessionId) === owner.pid ||
    (owner.hostId === hostId &&
      process.platform !== 'win32' &&
      (await providerOwnerHeldElsewhere(owner.pid)) === true)
  return kept
    ? { outcome: 'indeterminate', reason: 'owner kept running under the terminal host' }
    : null
}

/** Probe previous owners with PID-reuse-safe evidence; unresolved ownership remains indeterminate. */
export function createStructuredAgentSessionOwnerProbe(
  hostId: string,
  probe = probeAgentSessionProcessIdentity,
  findSpawnTokenProcesses = findAgentSessionSpawnTokenProcesses
): (record: AgentSessionRecord) => Promise<AgentSessionOwnerProbe> {
  return async (record) => {
    const kept = await keptRunningProbe(record, hostId)
    if (kept) {
      return kept
    }
    const owner = record.lease.ownerProcess
    if (!owner) {
      const spawnToken = record.lease.reservedSpawnToken
      if (spawnToken === null) {
        if (record.lease.claimStatus === 'reserved') {
          return {
            outcome: 'indeterminate',
            reason: 'reservation recorded no spawn token to scan for'
          }
        }
        // No owner or minted token means no child could hold this lease; indeterminate would trap a free record in recovery.
        return { outcome: 'reservation-unused' }
      }
      // Release requires positive evidence of no spawn; unreadable process environments yield null.
      return probeAgentSessionReservation({
        spawnToken,
        findProcessesWithSpawnToken: (token) => findSpawnTokenProcesses(token),
        hasProviderActivitySinceReservation: async () =>
          agentSessionReservationTouchedProvider(record)
      })
    }
    if (owner.hostId !== hostId) {
      // A remote pid has no meaning in this machine's process table.
      return {
        outcome: 'indeterminate',
        reason: `owner runs on ${owner.hostId}, which this host cannot probe`
      }
    }
    // Environment read-back can prove identity without start time; unsupported hosts return null.
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
      const kept = await keptRunningProbe(record, hostId)
      if (kept) {
        results.set(record.sessionId, kept)
      } else if (owner?.hostId === hostId) {
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

/** A handle link at this fence proves provider contact only after owner identity commit; pair it with the token scan to cover unrecorded activity. */
function agentSessionReservationTouchedProvider(record: AgentSessionRecord): boolean {
  return record.providerHandleChain.at(-1)?.mintedAtFence === record.lease.runtimeFence
}
