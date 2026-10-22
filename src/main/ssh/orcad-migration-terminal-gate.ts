/**
 * The dormant migration's terminal gate: a relay PTY cannot move into orcad, so the source must
 * prove that every terminal it ever leased on the target has exited, or (COMPAT legacy-relay-bridge)
 * leave the ones that may still run to the bridge. Loss of contact is never exit: a census that
 * cannot answer, or a lease nothing can account for, never reads as `exited`.
 */
import { isLiveSshPtyLease, type SshRemotePtyLease } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { PtyExitProof } from '../pty-exit-proof'

export type OrcadMigrationTerminalVerdict =
  | { verdict: 'exited'; provenPtyIds: string[] }
  /**
   * COMPAT(legacy-relay-bridge, revisit 2027-01-15): relay terminals may still run, and the host
   * converts anyway. Converting stops nothing; src/main/ssh/legacy-relay/ keeps serving
   * these leases' panes from the old relay until each terminal exits.
   */
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

/** A census of the host's relay endpoints. */
export type HostRelayTerminalProof = { verdict: 'exited' | 'live' | 'unverifiable'; count: number }

/**
 * Every relay endpoint on the account, whichever desktop's target launched it. The only evidence
 * that can prove the host idle; a census that throws proves nothing.
 */
export type CensusHostRelayTerminals = () => Promise<HostRelayTerminalProof>

type LeaseStore = Pick<Store, 'getSshRemotePtyLeases'>

/**
 * Taken before the fence. Read-only, so previews may ask. Only a complete host-wide census can
 * prove exit: another desktop's relay on the same account runs under a different target id, and
 * nothing else can answer for leases an older build left behind. Without a census, any lease that
 * may still run blocks, and an empty lease list is `unverifiable`, never exit.
 */
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

/**
 * Only the host-wide census counted them: no lease or listing of this target names one, so they
 * run under another desktop's target or session and stopping this target's terminals can't end them.
 */
export function terminalsRunElsewhere(proof: OrcadMigrationTerminalVerdict): boolean {
  return (
    (proof.verdict === 'live' || proof.verdict === 'unverifiable') &&
    proof.ptyIds.length === 0 &&
    (proof.hostTerminals ?? 0) > 0
  )
}

/**
 * Whoever acts on an exited proof (a conversion or a move) marks every lease it covers terminated,
 * so later checks stop reading them as running or unverifiable and the next connect can convert.
 * Attached ones too (#29083): only a host-wide census proves exit, and with no relay left on the
 * host an `attached` row is one an older build never got to detach.
 */
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

/**
 * Re-checked under the fence, after the direct session was let go: the fence stops new leases, so any
 * lease the earlier proof did not cover means a terminal started in between.
 */
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
