/**
 * The dormant migration's terminal gate: a relay PTY cannot move into orcad, so the source must
 * prove that every terminal it ever leased on the target has exited. Loss of contact is never
 * exit: an unanswered relay, or a lease the relay cannot account for, blocks as `unverifiable`.
 */
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import type { Store } from '../persistence'

export type OrcadMigrationTerminalVerdict =
  | { verdict: 'exited'; provenPtyIds: string[] }
  | { verdict: 'live' | 'unverifiable'; ptyIds: string[]; reason: string }

/** The relay's own process list for the target; `null` when it did not answer. */
export type ListRelayPtyIds = () => Promise<string[] | null>

type LeaseStore = Pick<Store, 'getSshRemotePtyLeases'>

/** Taken before the fence, while the relay can still be asked. */
export async function assessOrcadMigrationTerminals(
  store: LeaseStore,
  targetId: string,
  listRelayPtyIds: ListRelayPtyIds | null
): Promise<OrcadMigrationTerminalVerdict> {
  const leases = store.getSshRemotePtyLeases(targetId)
  const live = leases.filter((lease) => lease.state === 'attached' || lease.state === 'detached')
  if (live.length > 0) {
    return refuse('live', live, 'terminals on this host are still running')
  }
  let relayPtyIds: string[] | null
  try {
    relayPtyIds = listRelayPtyIds ? await listRelayPtyIds() : null
  } catch {
    relayPtyIds = null
  }
  if (relayPtyIds && relayPtyIds.length > 0) {
    return {
      verdict: 'live',
      ptyIds: [...relayPtyIds],
      reason: 'the SSH relay still runs terminals on this host'
    }
  }
  // An expired lease lost its owner without an exit record; only the relay can rule it out.
  const expired = leases.filter((lease) => lease.state === 'expired')
  if (expired.length > 0 && relayPtyIds === null) {
    return refuse('unverifiable', expired, 'the SSH relay could not confirm expired terminals')
  }
  return { verdict: 'exited', provenPtyIds: leases.map((lease) => lease.ptyId) }
}

/**
 * Re-checked under the fence, after the relay was let go: the fence stops new leases, so any
 * lease the earlier proof did not cover means a terminal started in between.
 */
export function confirmOrcadMigrationTerminalsUnderFence(
  store: LeaseStore,
  targetId: string,
  proof: OrcadMigrationTerminalVerdict
): OrcadMigrationTerminalVerdict {
  if (proof.verdict !== 'exited') {
    return proof
  }
  const proven = new Set(proof.provenPtyIds)
  const leases = store.getSshRemotePtyLeases(targetId)
  const live = leases.filter((lease) => lease.state === 'attached' || lease.state === 'detached')
  if (live.length > 0) {
    return refuse('live', live, 'a terminal started on this host before the fence took hold')
  }
  const unproven = leases.filter((lease) => !proven.has(lease.ptyId))
  if (unproven.some((lease) => lease.state !== 'terminated')) {
    return refuse(
      'unverifiable',
      unproven,
      'a terminal lease appeared on this host that the relay was not asked about'
    )
  }
  return proof
}

function refuse(
  verdict: 'live' | 'unverifiable',
  leases: SshRemotePtyLease[],
  reason: string
): OrcadMigrationTerminalVerdict {
  return { verdict, ptyIds: leases.map((lease) => lease.ptyId), reason }
}
