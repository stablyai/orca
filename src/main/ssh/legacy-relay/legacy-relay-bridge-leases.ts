/**
 * Which relay-era leases the bridge may serve.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 */
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { LegacyRelayBridgedPane } from '../../../shared/legacy-relay-bridge-contract'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { LegacyRelayPty } from './legacy-relay-client'

export type { LegacyRelayPty }

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
  listed?: LegacyRelayPty
  /** Its tab closed and its stop is still owed: listed for the stop, never served. */
  stopping?: true
}

export function toPane(
  lease: SshRemotePtyLease,
  relayPtyId: string,
  endpoint: string | null,
  state: Pane['state'],
  listed?: LegacyRelayPty
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
