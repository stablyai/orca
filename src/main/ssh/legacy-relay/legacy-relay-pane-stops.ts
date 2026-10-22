/**
 * One target's stops for bridged panes whose tab closed, sent with the old relay's own
 * `pty.shutdown`. COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 *
 * Held outside the bridge, so a reconnect's new bridge still sends them. A stop is pending until
 * the relay reports the exit or a listing proves the terminal gone; while the relay can't be asked
 * the answer is `unverifiable` and the stop goes out once it can. Loss of contact is never exit.
 *
 * A stop whose process can be named after a restart is persisted as the lease's `pendingKill`, the
 * relay-era record of the same intent, so closing a tab and quitting before reconnecting still
 * stops the shell. The relay connection is the other proof of identity, and it does not survive.
 */
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

/**
 * Who the closed tab's process was: the relay's incarnation when it reports one, else the live
 * connection that showed it. Neither, for a stop recorded while the relay couldn't be asked.
 */
type PendingStop = { incarnationId?: string; client?: LegacyRelayClient }

/** How a bridged stop was proven: the bridge saw the exit, or it holds no such terminal. */
export type LegacyRelayStopProof = 'reported' | 'gone'

/** How long a sent unfenced stop keeps its pane tracked for the relay's exit report. */
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
    // A repeated close keeps the identity the first one saw; the id may now name another process.
    const earlier = this.pending(ptyId)
    const incarnationId = earlier ? earlier.incarnationId : bridge?.listedIncarnation(ptyId)
    const client = earlier ? earlier.client : bridge?.liveRoute(ptyId)?.client
    this.closing.set(ptyId, {
      ...(incarnationId ? { incarnationId } : {}),
      ...(client ? { client } : {})
    })
    if (!this.record(ptyId, incarnationId)) {
      // Unfenced: only this connection can prove the process, and a restart would forget the close,
      // so it gets one try now and the lease ends as any closed tab's does.
      const attempted = Boolean(bridge) && state === 'live'
      const sent = bridge && attempted ? await this.send(ptyId, bridge) : false
      // A failed reply may still have stopped it, so its exit report gets the same chance.
      this.abandon(ptyId, bridge, attempted)
      return sent ? { status: 'requested' } : { status: 'unverifiable' }
    }
    if (!bridge || state !== 'live') {
      return { status: 'unverifiable' }
    }
    const sent = await this.send(ptyId, bridge)
    // Only the relay's exit report or a listing without the terminal proves the stop.
    void bridge.refresh()
    return sent ? { status: 'requested' } : { status: 'unverifiable' }
  }

  /**
   * Non-null only once the relay proves the exit: `reported` when the bridge saw it (and already
   * published it), `gone` when the bridge holds no such terminal. Null when unproven.
   */
  async stopAndWait(
    ptyId: string,
    bridge: StopTarget | null,
    deadlineMs: number
  ): Promise<LegacyRelayStopProof | null> {
    // Armed before the stop is sent, so an exit that beats its reply, or a lost reply, still counts.
    const exited = this.exits
      .wait(ptyId, Math.max(1, deadlineMs - Date.now()))
      .then((proven) => (proven ? ('reported' as const) : null))
    // A stop sent to a live pane may still prove out after a failed reply; an unsent one cannot.
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

  /** The bridge saw the pane exit. */
  exited(ptyId: string): void {
    this.exits.observe(ptyId)
  }

  /** Runs after each listing: re-sends pending stops, re-listing on backoff while one still runs. */
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
        // Its process's relay lost its socket to another: no stop can be fenced to it.
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

  /** Whether its tab closed and the stop is still owed, recorded now or by a previous run. */
  owes(ptyId: string): boolean {
    return this.pending(ptyId) !== undefined
  }

  get size(): number {
    return this.closing.size
  }

  /** This session's record of the stop, else the one a previous run persisted. */
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

  /** Persists a stop a later run can fence (a `pty2:` id or a listed incarnation); false if none. */
  private record(ptyId: string, incarnationId: string | undefined): boolean {
    const relayPtyId = parseAppSshPtyId(ptyId)?.relayPtyId
    if (!relayPtyId || (!incarnationId && !relayPtyId.startsWith('pty2:'))) {
      return false
    }
    const earlier = this.leases().find((lease) => lease.ptyId === relayPtyId)?.pendingKill
    // A repeated close keeps the first one's age, which a downgraded build's expiry reads.
    if (!earlier || earlier.incarnationId !== incarnationId) {
      this.persist(relayPtyId, {
        requestedAt: Date.now(),
        ...(incarnationId ? { incarnationId } : {}),
        attempts: 0
      })
    }
    return true
  }

  /**
   * The stop can't be proven to reach the tab's process, so it is never sent. The lease ends as any
   * closed tab's does, so a process that took the id is never served under the closed tab.
   */
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
    // The next listing drops the pane it still holds for that lease; after an attempted stop, only
    // once the relay's exit report had its chance, since dropping the pane first would hide it.
    const relist = attempted ? this.exits.wait(ptyId, UNFENCED_EXIT_WAIT_MS) : Promise.resolve()
    void relist.then(() => bridge?.refresh())
  }

  /** The old relay's own stop, fenced to the process the tab ran; false when it can't be asked. */
  private async send(ptyId: string, bridge: StopTarget): Promise<boolean> {
    const route = bridge.liveRoute(ptyId)
    const pending = this.pending(ptyId)
    if (!route || !pending) {
      return false
    }
    const listed = bridge.listedIncarnation(ptyId)
    // Only positive identity sends a stop: a legacy `pty-N` id restarts at 1 with its relay, and an
    // older relay ignores the incarnation fence. A `pty2:` id carries its relay's start epoch.
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
      // The relay's own fence refused it: that id now runs another process.
      if (/incarnation mismatch/i.test(error instanceof Error ? error.message : String(error))) {
        this.abandon(ptyId, bridge)
      }
      return false
    }
  }
}
