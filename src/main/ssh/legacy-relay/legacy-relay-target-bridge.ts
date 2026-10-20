/**
 * One SSH target's bridge: which leased relay-era panes an older relay still runs, and the
 * connections that carry their bytes until each terminal exits.
 * COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 *
 * Verdicts follow docs/reference/ssh-execution-boundary.md. A pane is `live` while a relay lists
 * it and `unverifiable` while its relay can't be asked; it is retired only when the relay reports
 * its exit, or when every relay this target could have left was asked and none holds it.
 */
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type {
  LegacyRelayBridgeAttachResult,
  LegacyRelayBridgedPane
} from '../../../shared/legacy-relay-bridge-contract'
import type { LegacyRelayClient, LegacyRelayOwnerClaim } from './legacy-relay-client'
import type { LegacyRelayEndpoint, LegacyRelayEndpointListing } from './legacy-relay-endpoints'
import { LegacyRelayRetry, LegacyRelayWaiters } from './legacy-relay-bridge-timers'
import {
  ATTACH_WAIT_MS,
  liveRouteOf,
  findLivePane,
  leasedAppPtyIds,
  listedLeasesByRelayId,
  type ListedRow,
  PROVEN_EXITED,
  relistedPane,
  seededPanes,
  servedBridgedPanes,
  type Pane
} from './legacy-relay-bridge-leases'
import type { LegacyRelayPaneOwners } from './legacy-relay-pane-owners'

export type LegacyRelayTargetBridgeDeps = {
  targetId: string
  /** The target's non-terminated leases. */
  leases: () => SshRemotePtyLease[]
  /** Only on the relay's word: its exit report, or every relay answered and none holds it. */
  retireLease: (relayPtyId: string, proof: 'exit-observed' | 'absent') => void
  listEndpoints: (signal: AbortSignal) => Promise<LegacyRelayEndpointListing>
  openClient: (
    endpoint: LegacyRelayEndpoint,
    resume: LegacyRelayOwnerClaim | null
  ) => Promise<LegacyRelayClient>
  /** Only a dead socket proves its relay gone; anything else about a failed open is unverifiable. */
  endpointExited: (endpoint: LegacyRelayEndpoint) => Promise<boolean>
  onPanesChanged: () => void
  onData: (ptyId: string, data: string) => void
  onExit: (ptyId: string, code: number) => void
  onTerminalExited: () => void
  /** The target's relay-id owners; the registry keeps them across bridges, so a reconnect keeps them. */
  owners: LegacyRelayPaneOwners
}

// Unique across bridges, so a viewer acquired on a replaced bridge releases nothing on its successor.
let lastAcquisitionId = 0

type EndpointState = {
  endpoint: LegacyRelayEndpoint
  client: LegacyRelayClient | null
  claim: LegacyRelayOwnerClaim | null
}

export class LegacyRelayTargetBridge {
  private readonly endpoints = new Map<string, EndpointState>()
  private readonly panes = new Map<string, Pane>()
  readonly livePaneForKey = (paneKey: string) =>
    findLivePane(this.panes, paneKey, this.deps.leases())
  /** The process identity the relay listed for a pane, which fences a stop against a recycled id. */
  readonly listedIncarnation = (ptyId: string) => this.panes.get(ptyId)?.listed?.incarnationId
  /** Whether a relay lists a pane now, including one whose stop is owed; undefined when untracked. */
  readonly paneState = (ptyId: string) => this.panes.get(ptyId)?.state
  readonly paneReplaced = (ptyId: string) => Boolean(this.panes.get(ptyId)?.replaced)
  private readonly attached = new Map<string, Set<number>>()
  private readonly waiters = new LegacyRelayWaiters()
  private readonly retry = new LegacyRelayRetry(() => void this.refresh())
  private refreshing: Promise<void> | null = null
  /** Set once a refresh has read the relays, so an attach never answers from an empty first look. */
  private looked = false
  /** Keeps the backoff growing while a listed terminal still refuses to attach. */
  private attachFailing = false
  private readonly abort = new AbortController()
  private disposed = false

  constructor(private readonly deps: LegacyRelayTargetBridgeDeps) {}

  livePaneCount(): number {
    return this.snapshot().filter((pane) => pane.state === 'live').length
  }

  snapshot(): LegacyRelayBridgedPane[] {
    return servedBridgedPanes(this.deps.targetId, this.panes, this.deps.leases())
  }

  /** Re-reads every relay; concurrent callers share one pass. */
  refresh(): Promise<void> {
    this.refreshing ??= this.runRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  async attach(
    ptyId: string,
    atSnapshot?: (replay: string) => void
  ): Promise<LegacyRelayBridgeAttachResult> {
    await (this.looked ? this.refreshing : this.refresh())
    let pane = this.panes.get(ptyId)
    if (pane?.state === 'unverifiable') {
      await this.waiters.waitUntil(
        () => this.disposed || this.panes.get(ptyId)?.state !== 'unverifiable',
        ATTACH_WAIT_MS
      )
      pane = this.panes.get(ptyId)
    }
    const leased = leasedAppPtyIds(this.deps.targetId, this.deps.leases()).has(ptyId)
    if (!pane) {
      return leased ? { status: 'unverifiable' } : { status: 'exited' }
    }
    // A close recorded while this attach waited: its stop is owed, so the pane is never served.
    if (!leased) {
      return { status: 'not-bridged' }
    }
    const client = this.liveRoute(ptyId)?.client
    if (!client) {
      return { status: 'unverifiable' }
    }
    // Why before the request: output that races the reply must reach the pane, not be dropped.
    const acquisitionId = ++lastAcquisitionId
    this.attached.set(ptyId, (this.attached.get(ptyId) ?? new Set()).add(acquisitionId))
    try {
      const { replay } = await client.attach(pane.relayPtyId, atSnapshot)
      this.attachFailing = false
      return { status: 'attached', replay, acquisitionId }
    } catch (error) {
      this.detach(ptyId, acquisitionId)
      if (PROVEN_EXITED.test(error instanceof Error ? error.message : String(error))) {
        this.retire(ptyId, pane, null)
        return { status: 'exited' }
      }
      // An unmarked refusal also means "never minted here": the next listing decides, on backoff.
      pane.state = 'unverifiable'
      this.attachFailing = true
      this.deps.onPanesChanged()
      this.retry.schedule()
      return { status: 'unverifiable' }
    }
  }

  detach(ptyId: string, acquisitionId: number): void {
    const viewers = this.attached.get(ptyId)
    if (viewers?.delete(acquisitionId) && viewers.size === 0) {
      this.attached.delete(ptyId)
    }
  }

  write(ptyId: string, data: string): void {
    const route = this.liveRoute(ptyId)
    route?.client.write(route.relayPtyId, data)
  }

  resize(ptyId: string, cols: number, rows: number): void {
    const route = this.liveRoute(ptyId)
    route?.client.resize(route.relayPtyId, cols, rows)
  }

  /** Hangs up every bridge connection; the relays keep their terminals and their own grace. */
  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.abort.abort()
    this.retry.cancel()
    this.closeIdleClients(new Set())
    this.panes.clear()
    this.attached.clear()
    this.deps.owners.clearExits()
    this.waiters.wake()
    this.deps.onPanesChanged()
  }

  private async runRefresh(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.looked = true
    const leases = listedLeasesByRelayId(this.deps.leases())
    if (leases.size === 0) {
      this.deps.owners.clearExits()
      this.closeIdleClients(new Set())
      this.replacePanes(new Map())
      return
    }
    // Every leased pane is published before the slow look, so a tab that mounts meanwhile waits on
    // its relay terminal rather than starting a second shell. Only proof of exit removes it.
    const seeded = seededPanes(this.deps.targetId, this.panes, leases)
    if (seeded) {
      this.replacePanes(seeded)
    }
    const listing = await this.deps.listEndpoints(this.abort.signal)
    if (this.disposed) {
      return
    }
    const listedRows: ListedRow[] = []
    let complete = listing.kind === 'listed' && listing.exhaustive
    for (const endpoint of listing.kind === 'listed' ? listing.endpoints : []) {
      const listed = await this.listEndpoint(endpoint)
      if (this.disposed) {
        return
      }
      if (listed === null) {
        complete = false
        continue
      }
      listedRows.push(...listed)
    }
    const next = new Map<string, Pane>()
    // Why re-read: a lease retired while the relays were asked (an exit) must not come back live.
    const current = [...listedLeasesByRelayId(this.deps.leases())].filter(([id]) => leases.has(id))
    for (const [relayPtyId, lease] of current) {
      const ptyId = toAppSshPtyId(this.deps.targetId, relayPtyId)
      const seen = relistedPane(lease, relayPtyId, listedRows, this.deps.owners, complete)
      if ('exited' in seen) {
        const proven = seen.exited !== null
        const counted = proven || Boolean(this.panes.get(ptyId)?.endpoint)
        this.deps.retireLease(relayPtyId, proven ? 'exit-observed' : 'absent')
        this.emitExit(ptyId, seen.exited ?? -1, counted)
      } else {
        next.set(ptyId, seen)
      }
    }
    this.deps.owners.clearExits()
    this.closeIdleClients(new Set([...next.values()].map((pane) => pane.endpoint ?? '')))
    this.replacePanes(next)
    // A contested pane is unverifiable under a complete listing too; only a later one resolves it.
    if (!complete || [...next.values()].some((p) => p.state === 'unverifiable' && !p.replaced)) {
      this.retry.schedule()
    } else if (!this.attachFailing) {
      this.retry.reset()
    }
  }

  /** The relay's PTYs, an empty list for a relay proven gone, or null when it can't be asked. */
  private async listEndpoint(endpoint: LegacyRelayEndpoint): Promise<ListedRow[] | null> {
    const state = this.endpoints.get(endpoint.endpoint) ?? { endpoint, client: null, claim: null }
    this.endpoints.set(endpoint.endpoint, state)
    if (!state.client || state.client.closed) {
      state.client = null
      if (!endpoint.connectCommand) {
        return null
      }
      try {
        const client = await this.deps.openClient(endpoint, state.claim)
        if (this.disposed) {
          client.close()
          return null
        }
        this.wireClient(endpoint.endpoint, client)
        state.client = client
        state.claim = client.ownerClaim
      } catch {
        return (await this.deps.endpointExited(endpoint).catch(() => false)) ? [] : null
      }
    }
    const { client } = state
    try {
      return (await client.list()).map((row) => ({ ...row, endpoint: endpoint.endpoint, client }))
    } catch {
      return null
    }
  }

  private wireClient(endpoint: string, client: LegacyRelayClient): void {
    client.onData((relayPtyId, data) => {
      const ptyId = toAppSshPtyId(this.deps.targetId, relayPtyId)
      if (this.attached.has(ptyId) && this.deps.owners.speaksFor(relayPtyId, endpoint, client)) {
        this.deps.onData(ptyId, data)
      }
    })
    client.onExit((relayPtyId, code) => {
      const ptyId = toAppSshPtyId(this.deps.targetId, relayPtyId)
      const pane = this.panes.get(ptyId)
      this.deps.owners.noteExit(relayPtyId, endpoint, code)
      if (pane && this.deps.owners.speaksFor(relayPtyId, endpoint, client)) {
        this.retire(ptyId, pane, code)
      }
    })
    client.onClose(() => {
      const state = this.endpoints.get(endpoint)
      if (this.disposed || state?.client !== client) {
        return
      }
      state.client = null
      let changed = false
      for (const pane of this.panes.values()) {
        if (pane.endpoint === endpoint) {
          pane.state = 'unverifiable'
          changed = true
        }
      }
      if (changed) {
        this.deps.onPanesChanged()
        this.waiters.wake()
        this.retry.schedule()
      }
    })
  }

  private retire(ptyId: string, pane: Pane, code: number | null): void {
    // A null code is the relay refusing an attach as proven exited.
    this.deps.owners.forget(pane.relayPtyId)
    this.deps.retireLease(pane.relayPtyId, code === null ? 'absent' : 'exit-observed')
    this.panes.delete(ptyId)
    this.emitExit(ptyId, code ?? -1)
    this.closeIdleClients(new Set([...this.panes.values()].map((entry) => entry.endpoint ?? '')))
    this.deps.onPanesChanged()
    this.waiters.wake()
  }

  /** Only a terminal this session saw running counts as a bridged exit in telemetry. */
  private emitExit(ptyId: string, code: number, counted = true): void {
    this.attached.delete(ptyId)
    this.deps.onExit(ptyId, code)
    if (counted) {
      this.deps.onTerminalExited()
    }
  }

  /** The connection that carries a live pane, or null while its relay can't be asked. */
  liveRoute(ptyId: string): { client: LegacyRelayClient; relayPtyId: string } | null {
    return liveRouteOf(this.panes.get(ptyId), this.endpoints, this.deps.owners)
  }

  private replacePanes(next: Map<string, Pane>): void {
    this.panes.clear()
    for (const [ptyId, pane] of next) {
      this.panes.set(ptyId, pane)
    }
    this.deps.onPanesChanged()
    this.waiters.wake()
  }

  /** A relay no pane needs is hung up; a later refresh reopens it if one appears. */
  private closeIdleClients(needed: Set<string>): void {
    for (const [endpoint, state] of this.endpoints) {
      if (!needed.has(endpoint)) {
        state.client?.close()
        this.endpoints.delete(endpoint)
      }
    }
  }
}
