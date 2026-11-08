/**
 * The bridged panes main tells the window about: each bridge's own listing, panes held over a
 * hang-up, and leased panes no bridge has listed yet.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import type { LegacyRelayBridgedPane } from '../../../shared/legacy-relay-bridge-contract'
import { parseAppSshPtyId, toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import { bridgeableLeasesByRelayId } from './legacy-relay-bridge-leases'

type LeaseHost = {
  /** Targets that still exist and have a stored lease. */
  leasedTargetIds: () => string[]
  leases: (targetId: string) => SshRemotePtyLease[]
}
type Stops = ReadonlyMap<string, { owes: (ptyId: string) => boolean }>
type Bridges = ReadonlyMap<string, { snapshot: () => LegacyRelayBridgedPane[] }>

export class LegacyRelayPaneList {
  /** Disconnected panes stay unverifiable until their host answers or leases end; loss of contact never proves exit. */
  private readonly held = new Map<string, LegacyRelayBridgedPane[]>()
  /** Targets a bridge has listed this run; from then on that listing, not the leases, decides. */
  private readonly listedTargets = new Set<string>()

  clear(): void {
    this.held.clear()
    this.listedTargets.clear()
  }

  /** A running bridge listed its target. */
  answered(targetId: string): void {
    this.held.delete(targetId)
    this.listedTargets.add(targetId)
  }

  hold(targetId: string, panes: LegacyRelayBridgedPane[]): void {
    if (panes.length > 0) {
      this.held.set(
        targetId,
        panes.map((pane) => ({ ...pane, state: 'unverifiable' as const }))
      )
    }
  }

  /** True when panes were held, so the list changed. */
  release(targetId: string): boolean {
    return this.held.delete(targetId)
  }

  forget(targetId: string): void {
    this.held.delete(targetId)
    this.listedTargets.delete(targetId)
  }

  list(host: LeaseHost | null, stops: Stops, bridges: Bridges): LegacyRelayBridgedPane[] {
    const answered = [
      ...[...bridges.values()].flatMap((bridge) => bridge.snapshot()),
      ...[...this.held].flatMap(([targetId, panes]) => stillLeased(host, targetId, panes))
    ]
    const listed = new Set(answered.map((pane) => pane.ptyId))
    // Not listed yet is never "none": before a host's first connect, an empty list would let a
    // mounting pane resume its agent on orcad while the relay still runs it.
    const unlisted = (host?.leasedTargetIds() ?? [])
      .filter((targetId) => !this.listedTargets.has(targetId))
      .flatMap((targetId) =>
        [...bridgeableLeasesByRelayId(host?.leases(targetId) ?? [])].flatMap(([relayId, lease]) => {
          const ptyId = toAppSshPtyId(targetId, relayId)
          // A closed tab's pane whose stop is owed is never served again.
          return listed.has(ptyId) || stops.get(targetId)?.owes(ptyId)
            ? []
            : [unverifiablePane(targetId, ptyId, lease)]
        })
      )
    return [...answered, ...unlisted]
  }
}

function stillLeased(
  host: LeaseHost | null,
  targetId: string,
  panes: LegacyRelayBridgedPane[]
): LegacyRelayBridgedPane[] {
  const leased = bridgeableLeasesByRelayId(host?.leases(targetId) ?? [])
  return panes.filter((pane) => leased.has(parseAppSshPtyId(pane.ptyId)?.relayPtyId ?? ''))
}

function unverifiablePane(
  targetId: string,
  ptyId: string,
  lease: SshRemotePtyLease
): LegacyRelayBridgedPane {
  return {
    ptyId,
    targetId,
    tabId: lease.tabId ?? '',
    ...(lease.leafId ? { leafId: lease.leafId } : {}),
    state: 'unverifiable'
  }
}
