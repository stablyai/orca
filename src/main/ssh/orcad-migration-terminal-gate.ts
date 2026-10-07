/**
 * The dormant migration's terminal gate: a relay PTY cannot move into orcad, so the source must
 * prove that every terminal it ever leased on the target has exited. Loss of contact is never
 * exit: an unanswered relay, or a lease the relay cannot account for, blocks as `unverifiable`.
 */
import { isLiveSshPtyLease } from '../../shared/ssh-pty-lease-liveness'
import type { SshRemotePtyLease } from '../../shared/ssh-types'
import type { Store } from '../persistence'

export type OrcadMigrationTerminalVerdict =
  | { verdict: 'exited'; provenPtyIds: string[] }
  | {
      verdict: 'live' | 'unverifiable'
      ptyIds: string[]
      reason: string
      /** Terminals the host-wide census counted, which it reports without ids. */
      hostTerminals?: number
    }

/**
 * The relay's own process list for the target; `null` when it did not answer. `previous` asks the
 * relays an earlier Orca build left running the same way, `null` when they cannot be asked.
 */
export type ListRelayPtyIds = (() => Promise<string[] | null>) & {
  previous?: () => Promise<string[] | null>
}

/** A census of the host's relay endpoints, taken when no relay session could be asked. */
export type HostRelayTerminalProof = { verdict: 'exited' | 'live' | 'unverifiable'; count: number }

/**
 * Every relay endpoint on the account, whichever desktop's target launched it. The only evidence
 * that can prove the host idle; a census that throws proves nothing.
 */
export type CensusHostRelayTerminals = () => Promise<HostRelayTerminalProof>

type LeaseStore = Pick<Store, 'getSshRemotePtyLeases'>

/**
 * Taken before the fence, while the relay can still be asked. Read-only, so previews may ask.
 * This target's relays can prove `live`, but their lists name only this target's instances, so
 * `exited` also needs a complete host-wide census: another desktop's relay on the same account runs
 * under a different target id. An inventory that is missing or failed is `unverifiable` even when
 * this desktop leases nothing.
 */
export async function assessOrcadMigrationTerminals(
  store: LeaseStore,
  targetId: string,
  listRelayPtyIds: ListRelayPtyIds | null,
  censusHost?: CensusHostRelayTerminals | null
): Promise<OrcadMigrationTerminalVerdict> {
  const leases = store.getSshRemotePtyLeases(targetId)
  const attached = leases.filter((lease) => lease.state === 'attached')
  // A detached or expired lease may run on this relay or one an earlier build left; both answer.
  const unresolved = leases.filter(
    (lease) => lease.state === 'detached' || lease.state === 'expired'
  )
  if (!listRelayPtyIds) {
    return await withoutRelaySession(leases, attached, unresolved, censusHost)
  }
  // The relays' own listings are the authority on what runs, leased or not: a CLI-created shell, or
  // one a respawn superseded on its tab, keeps running with no live lease here. Asking the earlier
  // relays only once this relay answered keeps a relay that answered nothing from counting as none.
  const relayPtyIds = await ask(listRelayPtyIds)
  const previousPtyIds = relayPtyIds ? await ask(listRelayPtyIds.previous) : null
  const running = [...(relayPtyIds ?? []), ...(previousPtyIds ?? [])]
  if (attached.length > 0 || running.length > 0) {
    return {
      verdict: 'live',
      ptyIds: [...new Set([...attached.map((lease) => lease.ptyId), ...running])],
      reason:
        attached.length > 0 || (relayPtyIds?.length ?? 0) > 0
          ? 'terminals on this host are still running'
          : 'an earlier Orca relay still runs terminals on this host'
    }
  }
  if (relayPtyIds === null) {
    return refuse(
      'unverifiable',
      unresolved,
      'the SSH relay could not confirm its terminals here exited'
    )
  }
  if (previousPtyIds === null) {
    return refuse('unverifiable', unresolved, 'Orca could not confirm its terminals here exited')
  }
  return await hostWideVerdict(leases, censusHost)
}

async function withoutRelaySession(
  leases: SshRemotePtyLease[],
  attached: SshRemotePtyLease[],
  unresolved: SshRemotePtyLease[],
  censusHost: CensusHostRelayTerminals | null | undefined
): Promise<OrcadMigrationTerminalVerdict> {
  if (attached.length > 0) {
    return refuse('live', attached, 'terminals on this host are still running')
  }
  if (unresolved.length > 0) {
    return refuse('unverifiable', unresolved, 'no SSH relay could confirm these terminals exited')
  }
  return await hostWideVerdict(leases, censusHost)
}

async function hostWideVerdict(
  leases: SshRemotePtyLease[],
  censusHost: CensusHostRelayTerminals | null | undefined
): Promise<OrcadMigrationTerminalVerdict> {
  const hostProof: HostRelayTerminalProof | null = censusHost
    ? await censusHost().catch(() => ({ verdict: 'unverifiable', count: 0 }) as const)
    : null
  if (hostProof?.verdict === 'exited') {
    return { verdict: 'exited', provenPtyIds: leases.map((lease) => lease.ptyId) }
  }
  if (hostProof) {
    return {
      verdict: hostProof.verdict,
      ptyIds: [],
      reason: "the host's relays still run or may run terminals",
      hostTerminals: hostProof.count
    }
  }
  return {
    verdict: 'unverifiable',
    ptyIds: [],
    reason: "no census of every relay on this host's account was taken"
  }
}

/**
 * Only the host-wide census counted them: no lease or listing of this target names one, so they
 * run under another desktop's target or session and stopping this target's terminals can't end them.
 */
export function terminalsRunElsewhere(proof: OrcadMigrationTerminalVerdict): boolean {
  return proof.verdict !== 'exited' && proof.ptyIds.length === 0 && (proof.hostTerminals ?? 0) > 0
}

/**
 * Whoever acts on an exited proof (a move, or a connect whose relay session answered) marks the
 * detached and expired leases it covers terminated, so later checks stop reading them as running
 * or unverifiable and the next connect can convert.
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
  for (const lease of store.getSshRemotePtyLeases(targetId)) {
    if ((lease.state === 'detached' || lease.state === 'expired') && proven.has(lease.ptyId)) {
      store.markSshRemotePtyLease(targetId, lease.ptyId, 'terminated')
    }
  }
}

async function ask(list: (() => Promise<string[] | null>) | null | undefined) {
  try {
    return list ? await list() : null
  } catch {
    return null
  }
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
