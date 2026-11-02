/**
 * One target's stops for bridged panes whose tab closed, sent with the old relay's own
 * `pty.shutdown`. COMPAT(legacy-relay-bridge): revisit 2027-01-15.
 *
 * Held outside the bridge, so a reconnect's new bridge still sends them. A stop is pending until
 * the relay reports the exit or a listing proves the terminal gone; while the relay can't be asked
 * the answer is `unverifiable` and the stop goes out once it can. Loss of contact is never exit.
 */
import type { SshRemotePtyLease } from '../../../shared/ssh-types'
import type { LegacyRelayBridgeCloseResult } from '../../../shared/legacy-relay-bridge-contract'
import { leasedAppPtyIds } from './legacy-relay-bridge-leases'
import { LegacyRelayRetry } from './legacy-relay-bridge-timers'
import type { LegacyRelayClient } from './legacy-relay-client'
import type { LegacyRelayTargetBridge } from './legacy-relay-target-bridge'

type StopTarget = Pick<
  LegacyRelayTargetBridge,
  'snapshot' | 'liveRoute' | 'listedIncarnation' | 'refresh'
>

/**
 * Who the closed tab's process was: the relay's incarnation when it reports one, else the live
 * connection that showed it. Neither, for a stop recorded while the relay couldn't be asked.
 */
type PendingStop = { incarnationId?: string; client?: LegacyRelayClient }

export class LegacyRelayPaneStops {
  private readonly closing = new Map<string, PendingStop>()
  private bridge: StopTarget | null = null
  private readonly relist = new LegacyRelayRetry(() => void this.bridge?.refresh())

  constructor(
    private readonly targetId: string,
    private readonly leases: () => SshRemotePtyLease[]
  ) {}

  /** `bridge` is null while the target is disconnected; its next listing sends the stop. */
  async stop(ptyId: string, bridge: StopTarget | null): Promise<LegacyRelayBridgeCloseResult> {
    const pane = bridge?.snapshot().find((entry) => entry.ptyId === ptyId)
    if (!pane && !leasedAppPtyIds(this.targetId, this.leases()).has(ptyId)) {
      return { status: 'exited' }
    }
    // A repeated close while the relay can't be asked keeps the identity the first one saw.
    const earlier = this.closing.get(ptyId)
    const incarnationId = bridge?.listedIncarnation(ptyId) ?? earlier?.incarnationId
    const client = bridge?.liveRoute(ptyId)?.client ?? earlier?.client
    this.closing.set(ptyId, {
      ...(incarnationId ? { incarnationId } : {}),
      ...(client ? { client } : {})
    })
    if (!bridge || pane?.state !== 'live') {
      return { status: 'unverifiable' }
    }
    const sent = await this.send(ptyId, bridge)
    // Only the relay's exit report or a listing without the terminal proves the stop.
    void bridge.refresh()
    return sent ? { status: 'requested' } : { status: 'unverifiable' }
  }

  /** Runs after each listing: re-sends pending stops, re-listing on backoff while one still runs. */
  flush(bridge: StopTarget): void {
    this.bridge = bridge
    const panes = new Map(bridge.snapshot().map((pane) => [pane.ptyId, pane]))
    const leased = leasedAppPtyIds(this.targetId, this.leases())
    let pending = false
    for (const ptyId of this.closing.keys()) {
      const pane = panes.get(ptyId)
      if (!pane) {
        if (!leased.has(ptyId)) {
          this.closing.delete(ptyId)
        }
        continue
      }
      pending = true
      if (pane.state === 'live') {
        void this.send(ptyId, bridge)
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
    this.closing.clear()
  }

  get size(): number {
    return this.closing.size
  }

  /** The old relay's own stop, fenced to the process the tab ran; false when it can't be asked. */
  private async send(ptyId: string, bridge: StopTarget): Promise<boolean> {
    const route = bridge.liveRoute(ptyId)
    const pending = this.closing.get(ptyId)
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
      this.closing.delete(ptyId)
      return false
    }
    try {
      await route.client.shutdown(route.relayPtyId, pending.incarnationId)
      return true
    } catch (error) {
      // The relay's own fence refused it: that id now runs another process.
      if (/incarnation mismatch/i.test(error instanceof Error ? error.message : String(error))) {
        this.closing.delete(ptyId)
      }
      return false
    }
  }
}
