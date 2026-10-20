/**
 * Which relay-era leases the bridge may serve.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { LegacyRelayBridgedPane } from '../../../shared/legacy-relay-bridge-contract'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { LegacyRelayClient, LegacyRelayPty } from './legacy-relay-client'
import { isEpochScopedRelayPtyId } from '../../../shared/ssh-pending-pty-kill'
import type { LegacyRelayPaneOwners } from './legacy-relay-pane-owners'

export type { LegacyRelayPty }

/** A relay's listing row: the endpoint that answered, and the connection the answer came on. */
export type ListedRow = LegacyRelayPty & { endpoint: string; client?: LegacyRelayClient }

/** How long an attach waits for an unreachable relay before answering `unverifiable`. */
export const ATTACH_WAIT_MS = 20_000
/** The one attach refusal backed by the relay's own liveness check (1.4.2xx relays). */
export const PROVEN_EXITED = /PTY ".+" not found \(process exited\)/i

/** A relay-era pane's lease whose shell may still run; one a newer pane won is never brought back. */
function isRelayEraPaneLease(lease: SshRemotePtyLease): boolean {
  return (
    lease.state !== 'terminated' &&
    typeof lease.tabId === 'string' &&
    lease.tabId.length > 0 &&
    !lease.supersededBy &&
    !lease.relayIdRecycled
  )
}

/** One a relay-era pane still names and nobody closed. */
export function isBridgeableLease(lease: SshRemotePtyLease): boolean {
  return isRelayEraPaneLease(lease) && !lease.pendingKill
}

/**
 * One whose tab closed before its relay confirmed the stop. The bridge still lists its relay to
 * send the stop, including after a restart, but never serves it as a pane again.
 */
export function isStoppingLease(lease: SshRemotePtyLease): boolean {
  return isRelayEraPaneLease(lease) && Boolean(lease.pendingKill)
}

export function bridgeableLeasesByRelayId(
  leases: readonly SshRemotePtyLease[]
): Map<string, SshRemotePtyLease> {
  return new Map(leases.filter(isBridgeableLease).map((lease) => [lease.ptyId, lease]))
}

/** Every lease the bridge lists a relay for: the panes it serves and the stops it owes. */
export function listedLeasesByRelayId(
  leases: readonly SshRemotePtyLease[]
): Map<string, SshRemotePtyLease> {
  return new Map(
    leases
      .filter((lease) => isBridgeableLease(lease) || isStoppingLease(lease))
      .map((lease) => [lease.ptyId, lease])
  )
}

export function leasedAppPtyIds(targetId: string, leases: SshRemotePtyLease[]): Set<string> {
  return toAppPtyIds(targetId, bridgeableLeasesByRelayId(leases))
}

export function listedAppPtyIds(targetId: string, leases: SshRemotePtyLease[]): Set<string> {
  return toAppPtyIds(targetId, listedLeasesByRelayId(leases))
}

function toAppPtyIds(targetId: string, leases: Map<string, SshRemotePtyLease>): Set<string> {
  return new Set([...leases.keys()].map((relayPtyId) => toAppSshPtyId(targetId, relayPtyId)))
}

/** One leased pane the bridge tracks, and the relay endpoint that listed it. */
export type Pane = {
  lease: SshRemotePtyLease
  relayPtyId: string
  endpoint: string | null
  state: 'live' | 'unverifiable'
  /** What the listing relay claimed about the process, for the relay-era CLI's identity checks. */
  listed?: ListedRow
  /** Its tab closed and its stop is still owed: listed for the stop, never served. */
  stopping?: true
  /** Its relay's socket now runs another relay: no listing can bring it back or prove it gone, so it
   *  schedules no retry, and a stop owed to it is abandoned rather than sent. */
  replaced?: true
}

export function toPane(
  lease: SshRemotePtyLease,
  relayPtyId: string,
  endpoint: string | null,
  state: Pane['state'],
  listed?: ListedRow
): Pane {
  return {
    lease,
    relayPtyId,
    endpoint,
    state,
    ...(listed ? { listed } : {}),
    ...(lease.pendingKill ? { stopping: true as const } : {})
  }
}

/** Every leased pane not yet tracked, as unverifiable; null when all already are. */
export function seededPanes(
  targetId: string,
  panes: ReadonlyMap<string, Pane>,
  leases: ReadonlyMap<string, SshRemotePtyLease>
): Map<string, Pane> | null {
  const seeded = new Map(panes)
  for (const [relayPtyId, lease] of leases) {
    const ptyId = toAppSshPtyId(targetId, relayPtyId)
    if (!seeded.has(ptyId)) {
      seeded.set(ptyId, toPane(lease, relayPtyId, null, 'unverifiable'))
    }
  }
  return seeded.size !== panes.size ? seeded : null
}

/**
 * A leased pane after a listing, or the proof it ended: `exited` is its exit code, or `null` once
 * every relay that could run it answered without it. `complete`: every relay the host runs was
 * accounted for and answered.
 */
export function relistedPane(
  lease: SshRemotePtyLease,
  relayPtyId: string,
  listedRows: readonly ListedRow[],
  owners: LegacyRelayPaneOwners,
  complete: boolean
): Pane | { exited: number | null } {
  const rows = listedRows.filter((row) => row.relayPtyId === relayPtyId)
  if (owners.owner(relayPtyId) === undefined && rows.length > 1) {
    owners.claimContested(relayPtyId)
  }
  const owner = owners.owner(relayPtyId)
  // Why only on a complete listing: a relay that could not be asked, or that the host's census
  // could not account for, may be the one running it, and an owner once pinned is never revisited.
  // An epoch-scoped id names one process on one relay, so its sole lister is its owner regardless.
  const provable = complete || isEpochScopedRelayPtyId(relayPtyId)
  const adopted = owner === undefined && provable && rows.length === 1 ? rows[0] : undefined
  const ownRow = owner ? rows.find((row) => row.endpoint === owner) : undefined
  // A relay restarted at the owner's socket numbers its shells from pty-1 again: same id, another
  // process. Never bound, so no attach, input, stop or report ever reaches it.
  const replaced = ownRow !== undefined && !owners.isOwnerProcess(relayPtyId, ownRow)
  if (replaced) {
    owners.markReplaced(relayPtyId)
  }
  const listed = replaced ? undefined : (ownRow ?? adopted)
  // The owner's relay answering without it proves the exit; a replacement's silence proves nothing.
  const ownerSilent = owner ? !owners.isReplaced(relayPtyId) : rows.length === 0
  // A listing taken before its relay's exit report must not bring the pane back live.
  // An epoch-scoped id names one process, so its owner's report counts without a listing row.
  const exitEndpoint =
    listed && !replaced ? listed.endpoint : isEpochScopedRelayPtyId(relayPtyId) ? owner : null
  const exitedFirst = exitEndpoint ? owners.exitBeforeListing(relayPtyId, exitEndpoint) : undefined
  if (exitedFirst !== undefined || (!listed && complete && ownerSilent)) {
    owners.forget(relayPtyId)
    return { exited: exitedFirst ?? null }
  }
  if (listed) {
    owners.bind(relayPtyId, listed)
    return toPane(lease, relayPtyId, listed.endpoint, 'live', listed)
  }
  // Unreachable, contested or replaced: loss of contact is never exit, so the pane waits.
  const waiting = toPane(lease, relayPtyId, null, 'unverifiable')
  return owners.isReplaced(relayPtyId) ? { ...waiting, replaced: true } : waiting
}

/** The connection a live pane's attach, input and stop go to: only one the ledger says speaks for it. */
export function liveRouteOf(
  pane: Pane | undefined,
  endpoints: ReadonlyMap<string, { client: LegacyRelayClient | null }>,
  owners: LegacyRelayPaneOwners
): { client: LegacyRelayClient; relayPtyId: string } | null {
  const client = pane?.endpoint ? endpoints.get(pane.endpoint)?.client : null
  const speaks =
    pane?.state === 'live' && pane.endpoint && client
      ? owners.speaksFor(pane.relayPtyId, pane.endpoint, client)
      : false
  return speaks && pane && client ? { client, relayPtyId: pane.relayPtyId } : null
}

/** The panes a bridge serves; a closed tab's pane, its stop owed or its lease ended, is not one. */
export function servedBridgedPanes(
  targetId: string,
  panes: ReadonlyMap<string, Pane>,
  leases: readonly SshRemotePtyLease[]
): LegacyRelayBridgedPane[] {
  const served = bridgeableLeasesByRelayId(leases)
  return [...panes]
    .filter(([, pane]) => !pane.stopping && served.has(pane.relayPtyId))
    .map(([ptyId, pane]) => toBridgedPane(targetId, ptyId, pane))
}

export type LegacyRelayLivePane = { ptyId: string; incarnationId?: string; terminalHandle?: string }

/** The live leased pane a pane key's stable leaf names; the lease is the desktop's own record. */
export function findLivePane(
  panes: ReadonlyMap<string, Pane>,
  paneKey: string,
  leases: readonly SshRemotePtyLease[]
): LegacyRelayLivePane | null {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  const served = bridgeableLeasesByRelayId(leases)
  for (const [ptyId, pane] of panes) {
    // Why the leaf alone: a moved pane's lease takes its new tab, but its shell keeps the old key.
    const named = pane.lease.leafId === parsed.leafId && served.has(pane.relayPtyId)
    if (pane.state === 'live' && !pane.stopping && named) {
      const { incarnationId, terminalHandle } = pane.listed ?? {}
      return {
        ptyId,
        ...(incarnationId ? { incarnationId } : {}),
        ...(terminalHandle ? { terminalHandle } : {})
      }
    }
  }
  return null
}

function toBridgedPane(targetId: string, ptyId: string, pane: Pane): LegacyRelayBridgedPane {
  return {
    ptyId,
    targetId,
    tabId: pane.lease.tabId ?? '',
    ...(pane.lease.leafId ? { leafId: pane.lease.leafId } : {}),
    state: pane.state
  }
}
