/** Relay PTYs cannot move to orcad: prove host-wide exit or retain possible survivors in the legacy bridge. Lost contact and unaccounted leases never prove exit. */
import { isLiveSshPtyLease, type SshRemotePtyLease } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { PtyExitProof } from '../pty-exit-proof'

export type OrcadMigrationTerminalVerdict =
  | { verdict: 'exited'; provenPtyIds: string[] }
  /** COMPAT(legacy-relay-bridge, revisit 2027-01-15): conversion stops nothing; the bridge serves possible surviving leases until relay-proven exit. */
  | {
      verdict: 'bridged'
      relayVerdict: 'live' | 'unverifiable'
      bridgedPtyIds: string[]
      hostTerminals: number
    }
  | {
      verdict: 'live' | 'unverifiable'
      ptyIds: string[]
      reason: string
      /** Terminals the host-wide census counted, which it reports without ids. */
      hostTerminals?: number
    }

export type HostRelayTerminalProof = { verdict: 'exited' | 'live' | 'unverifiable'; count: number }

/** Only a complete account-wide relay census can prove idle; other desktops hash different target ids and failed censuses prove nothing. */
export type CensusHostRelayTerminals = () => Promise<HostRelayTerminalProof>

type LeaseStore = Pick<Store, 'getSshRemotePtyLeases'>

/** Read-only pre-fence assessment. Only host-wide census proves exit; without it even an empty local lease list stays unverifiable. */
export async function assessOrcadMigrationTerminals(
  store: LeaseStore,
  targetId: string,
  censusHost?: CensusHostRelayTerminals | null
): Promise<OrcadMigrationTerminalVerdict> {
  const leases = store.getSshRemotePtyLeases(targetId)
  if (censusHost) {
    return await hostWideVerdict(leases, censusHost)
  }
  const attached = leases.filter((lease) => lease.state === 'attached')
  if (attached.length > 0) {
    return refuse('live', attached, 'terminals on this host are still running')
  }
  const unresolved = leases.filter(
    (lease) => lease.state === 'detached' || lease.state === 'expired'
  )
  if (unresolved.length > 0) {
    return refuse('unverifiable', unresolved, 'no SSH relay could confirm these terminals exited')
  }
  return {
    verdict: 'unverifiable',
    ptyIds: [],
    reason: "no census of every relay on this host's account was taken"
  }
}

async function hostWideVerdict(
  leases: SshRemotePtyLease[],
  censusHost: CensusHostRelayTerminals
): Promise<OrcadMigrationTerminalVerdict> {
  const hostProof = await censusHost().catch((): HostRelayTerminalProof => ({
    verdict: 'unverifiable',
    count: 0
  }))
  if (hostProof.verdict === 'exited') {
    return { verdict: 'exited', provenPtyIds: leases.map((lease) => lease.ptyId) }
  }
  return {
    verdict: 'bridged',
    relayVerdict: hostProof.verdict,
    bridgedPtyIds: leases.filter((lease) => lease.state !== 'terminated').map((l) => l.ptyId),
    hostTerminals: hostProof.count
  }
}

/** Host-censused terminals without local leases belong to another desktop/session; stopping this target cannot end them. */
export function terminalsRunElsewhere(proof: OrcadMigrationTerminalVerdict): boolean {
  return (
    (proof.verdict === 'live' || proof.verdict === 'unverifiable') &&
    proof.ptyIds.length === 0 &&
    (proof.hostTerminals ?? 0) > 0
  )
}

/** Retire every lease covered by proven host-wide exit, including attached rows older builds never detached (#29083). */
export function retireProvenExitedLeases(
  store: Pick<Store, 'getSshRemotePtyLeases' | 'markSshRemotePtyLease'>,
  targetId: string,
  proof: OrcadMigrationTerminalVerdict
): void {
  if (proof.verdict !== 'exited') {
    return
  }
  const proven = new Set(proof.provenPtyIds)
  const census = PtyExitProof.from('host-census', undefined)
  for (const lease of store.getSshRemotePtyLeases(targetId)) {
    if (lease.state !== 'terminated' && proven.has(lease.ptyId)) {
      store.markSshRemotePtyLease(targetId, lease.ptyId, census)
    }
  }
}

/** Recheck after fencing blocks new leases: any lease absent from the earlier proof started between checks. */
export function confirmOrcadMigrationTerminalsUnderFence(
  store: LeaseStore,
  targetId: string,
  proof: OrcadMigrationTerminalVerdict
): OrcadMigrationTerminalVerdict {
  if (proof.verdict !== 'exited' && proof.verdict !== 'bridged') {
    return proof
  }
  const proven = new Set(proof.verdict === 'exited' ? proof.provenPtyIds : [])
  // COMPAT(legacy-relay-bridge): a lease the bridge holds is accounted for, never a new terminal.
  const bridged = new Set(proof.verdict === 'bridged' ? proof.bridgedPtyIds : [])
  const leases = store.getSshRemotePtyLeases(targetId).filter((lease) => !bridged.has(lease.ptyId))
  const live = leases.filter(isLiveSshPtyLease)
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
