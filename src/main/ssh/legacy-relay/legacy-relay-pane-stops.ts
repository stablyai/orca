/** Retain closed-pane stops across reconnects until relay exit/absence is proven; lost contact stays unverifiable. Persist restart-fenced intent as pendingKill; connection-only identity cannot survive restart. COMPAT(legacy-relay-bridge): revisit 2027-01-15. */
import { parseAppSshPtyId, toAppSshPtyId } from '../../../shared/ssh-pty-id'
import type { SshPendingPtyKill } from '../../../shared/ssh-pending-pty-kill'
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { LegacyRelayBridgeCloseResult } from '../../../shared/legacy-relay-bridge-contract'
import { isStoppingLease, listedAppPtyIds } from './legacy-relay-bridge-leases'
import { LegacyRelayExitProofs, LegacyRelayRetry } from './legacy-relay-bridge-timers'
import type { LegacyRelayClient } from './legacy-relay-client'
import type { LegacyRelayBridgeHost } from './legacy-relay-bridge-registry'
import type { LegacyRelayTargetBridge } from './legacy-relay-target-bridge'
import { PtyRetirementWithoutProof } from '../../pty-exit-proof'

type StopTarget = Pick<
  LegacyRelayTargetBridge,
  'paneState' | 'paneReplaced' | 'liveRoute' | 'listedIncarnation' | 'refresh'
>

/** Fence by incarnation or the live connection that listed the process; neither is known for an offline close. */
type PendingStop = { incarnationId?: string; client?: LegacyRelayClient }

export type LegacyRelayStopProof = 'reported' | 'gone'

/** Allow an unfenced stop's exit report to arrive before dropping its pane. */
const UNFENCED_EXIT_WAIT_MS = 5_000

export class LegacyRelayPaneStops {
  private readonly closing = new Map<string, PendingStop>()
  private bridge: StopTarget | null = null
  private readonly relist = new LegacyRelayRetry(() => void this.bridge?.refresh())
  private readonly exits = new LegacyRelayExitProofs()

  constructor(
    private readonly targetId: string,
    private readonly host: () => Pick<
      LegacyRelayBridgeHost,
      'leases' | 'recordStop' | 'retireLease'
    > | null
  ) {}

  private leases(): SshRemotePtyLease[] {
    return this.host()?.leases(this.targetId) ?? []
  }

  private persist(relayPtyId: string, pendingKill: SshPendingPtyKill): void {
    this.host()?.recordStop(this.targetId, relayPtyId, pendingKill)
  }

  /** `bridge` is null while the target is disconnected; its next listing sends the stop. */
  async stop(ptyId: string, bridge: StopTarget | null): Promise<LegacyRelayBridgeCloseResult> {
    const state = bridge?.paneState(ptyId)
    if (!state && !listedAppPtyIds(this.targetId, this.leases()).has(ptyId)) {
      return { status: 'exited' }
    }
    // Repeated closes retain the first process identity; the id may now be recycled.
    const earlier = this.pending(ptyId)
    const incarnationId = earlier ? earlier.incarnationId : bridge?.listedIncarnation(ptyId)
    const client = earlier ? earlier.client : bridge?.liveRoute(ptyId)?.client
    this.closing.set(ptyId, {
      ...(incarnationId ? { incarnationId } : {}),
      ...(client ? { client } : {})
    })
    if (!this.record(ptyId, incarnationId)) {
      // Connection-only identity gets one attempt now; retire the lease because no restart can fence it.
      const attempted = Boolean(bridge) && state === 'live'
      const sent = bridge && attempted ? await this.send(ptyId, bridge) : false
      // A failed reply may still have stopped the process; allow its exit report.
      this.abandon(ptyId, bridge, attempted)
      return sent ? { status: 'requested' } : { status: 'unverifiable' }
    }
    if (!bridge || state !== 'live') {
      return { status: 'unverifiable' }
    }
    const sent = await this.send(ptyId, bridge)
    // Only relay-reported exit or a listing without the process proves the stop.
    void bridge.refresh()
    return sent ? { status: 'requested' } : { status: 'unverifiable' }
  }

  /** Return reported/gone only on relay-proven exit/absence; null means unproven. */
  async stopAndWait(
    ptyId: string,
    bridge: StopTarget | null,
    deadlineMs: number
  ): Promise<LegacyRelayStopProof | null> {
    // Arm before sending so early exits and lost replies still count.
    const exited = this.exits
      .wait(ptyId, Math.max(1, deadlineMs - Date.now()))
      .then((proven) => (proven ? ('reported' as const) : null))
    // A failed reply can still precede exit; an unsent stop cannot.
    const sendable = bridge?.paneState(ptyId) === 'live'
    const stopped = this.stop(ptyId, bridge).then((result) =>
      result.status === 'exited'
        ? ('gone' as const)
        : result.status === 'requested' || sendable
          ? exited
          : null
    )
    return Promise.race([exited.then((proven) => proven ?? stopped), stopped])
  }

  exited(ptyId: string): void {
    this.exits.observe(ptyId)
  }

  /** Retry pending stops after listing, with backoff while the process still runs. */
  flush(bridge: StopTarget): void {
    this.bridge = bridge
    const leases = this.leases()
    const listed = listedAppPtyIds(this.targetId, leases)
    const owed = new Set([...this.closing.keys(), ...this.persisted(leases).keys()])
    let pending = false
    for (const ptyId of owed) {
      const state = bridge.paneState(ptyId)
      if (!state) {
        if (!listed.has(ptyId)) {
          this.closing.delete(ptyId)
        }
        continue
      }
      pending = true
      if (state === 'live') {
        void this.send(ptyId, bridge)
      } else if (bridge.paneReplaced(ptyId)) {
        // Another relay took the socket, so the old process can no longer be fenced.
        this.abandon(ptyId, bridge)
      }
    }
    if (pending) {
      this.relist.schedule()
    } else {
      this.relist.reset()
    }
  }

  dispose(): void {
    this.relist.cancel()
    this.exits.dispose()
    this.closing.clear()
  }

  owes(ptyId: string): boolean {
    return this.pending(ptyId) !== undefined
  }

  get size(): number {
    return this.closing.size
  }

  private pending(ptyId: string): PendingStop | undefined {
    return this.closing.get(ptyId) ?? this.persisted(this.leases()).get(ptyId)
  }

  private persisted(leases: SshRemotePtyLease[]): Map<string, PendingStop> {
    const stops = new Map<string, PendingStop>()
    for (const lease of leases) {
      if (isStoppingLease(lease)) {
        const incarnationId = lease.pendingKill?.incarnationId
        stops.set(toAppSshPtyId(this.targetId, lease.ptyId), incarnationId ? { incarnationId } : {})
      }
    }
    return stops
  }

  /** Persist only restart-fenced stops: epoch-scoped ids or listed incarnations. */
  private record(ptyId: string, incarnationId: string | undefined): boolean {
    const relayPtyId = parseAppSshPtyId(ptyId)?.relayPtyId
    if (!relayPtyId || (!incarnationId && !relayPtyId.startsWith('pty2:'))) {
      return false
    }
    const earlier = this.leases().find((lease) => lease.ptyId === relayPtyId)?.pendingKill
    // Retain the first close's age for downgraded builds that expire pendingKill.
    if (!earlier || earlier.incarnationId !== incarnationId) {
      this.persist(relayPtyId, {
        requestedAt: Date.now(),
        ...(incarnationId ? { incarnationId } : {}),
        attempts: 0
      })
    }
    return true
  }

  /** Abandon unfenceable stops and retire the closed lease so a replacement process is never served as its pane. */
  private abandon(ptyId: string, bridge: StopTarget | null, attempted = false): void {
    this.closing.delete(ptyId)
    const relayPtyId = parseAppSshPtyId(ptyId)?.relayPtyId
    if (relayPtyId) {
      this.host()?.retireLease(
        this.targetId,
        relayPtyId,
        PtyRetirementWithoutProof.because('the old relay could not be sent a stop fenced to it')
      )
    }
    // Wait for an attempted stop's exit report before relisting drops the pane that would receive it.
    const relist = attempted ? this.exits.wait(ptyId, UNFENCED_EXIT_WAIT_MS) : Promise.resolve()
    void relist.then(() => bridge?.refresh())
  }

  private async send(ptyId: string, bridge: StopTarget): Promise<boolean> {
    const route = bridge.liveRoute(ptyId)
    const pending = this.pending(ptyId)
    if (!route || !pending) {
      return false
    }
    const listed = bridge.listedIncarnation(ptyId)
    // Legacy pty-N ids recycle and older relays ignore fences; absent a matching incarnation, require connection/epoch identity.
    const sameProcess = route.client === pending.client || route.relayPtyId.startsWith('pty2:')
    const proven = pending.incarnationId
      ? listed === pending.incarnationId || (listed === undefined && sameProcess)
      : sameProcess
    if (!proven) {
      this.abandon(ptyId, bridge)
      return false
    }
    try {
      await route.client.shutdown(route.relayPtyId, pending.incarnationId)
      return true
    } catch (error) {
      // Incarnation refusal proves the id now names another process.
      if (/incarnation mismatch/i.test(error instanceof Error ? error.message : String(error))) {
        this.abandon(ptyId, bridge)
      }
      return false
    }
  }
}
