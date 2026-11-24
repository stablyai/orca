import type {
  ProviderRelayDetachPolicy,
  ProviderRelayRecord
} from '../protocol/daemon-provider-relay-protocol'
import {
  isProviderRelayQuietLine,
  ProviderRelayOpenWork,
  ProviderRelayWorkReader
} from './provider-relay-work-markers'

export { readProviderRelayDetachPolicy } from './provider-relay-work-markers'

type IdleStopHost = {
  attached: () => boolean
  live: () => boolean
  pendingCount: () => number
  workRequests?: (methods: readonly string[]) => void
  /**
   * Lines after the last ack: the app may not have counted them in its open set yet. Null when some
   * are no longer in memory, so what they opened can't be known.
   */
  unacked: () => readonly ProviderRelayRecord[] | null
  stop: () => void
  log?: (event: string, details?: Record<string, unknown>) => void
}

/**
 * The user's native-chat idle stop for a detached agent, by the open app's own rule: a running
 * turn, a waiting approval or a background task the agent reports is never idle.
 */
export class ProviderRelayIdleStop {
  /** The app's policy, known from spawn or attach; a detach's own policy replaces it. */
  private policy: ProviderRelayDetachPolicy | null = null
  private reader: ProviderRelayWorkReader | null = null
  private work: ProviderRelayOpenWork | null = null
  private carried: Record<string, string[][]> | null = null
  private ended: Record<string, string[][]> | null = null
  private armed = false
  /** Busy when last checked: the next agent line starts a fresh window. */
  private waitingForLine = false
  private lastActivityAt = Date.now()
  private timer: ReturnType<typeof setTimeout> | null = null
  private quietNames: ReadonlySet<string> = new Set()

  constructor(private readonly host: IdleStopHost) {}

  static forRelay(
    relay: {
      readonly live: boolean
      readonly attachedClientId: string | null
      readonly pending: {
        readonly size: number
        readonly working: { readonly size: number }
        workMethods: ReadonlySet<string>
      }
      close: () => Promise<unknown>
    },
    options: { relayId: string; log?: (event: string, details?: Record<string, unknown>) => void },
    unacked: () => readonly ProviderRelayRecord[] | null
  ): ProviderRelayIdleStop {
    return new ProviderRelayIdleStop({
      attached: () => relay.attachedClientId !== null,
      live: () => relay.live,
      // Held approvals, and the app's own work requests (an ACP turn) the agent hasn't answered.
      pendingCount: () => relay.pending.size + relay.pending.working.size,
      workRequests: (methods) => {
        relay.pending.workMethods = new Set(methods)
      },
      unacked,
      stop: () => void relay.close().catch(() => {}),
      log: (event, details) => options.log?.(event, { relayId: options.relayId, ...details })
    })
  }

  /** Learned at spawn or attach, for a stream that drops without a detach of its own. */
  configure(policy: ProviderRelayDetachPolicy | null): void {
    if (policy) {
      this.adopt(policy)
    }
  }

  /**
   * The window starts now. Only a detach that says what is open can stop the agent: its open set,
   * plus what the lines it hadn't acked yet open or close, is the work. Call before the spool
   * moves those lines to its file.
   */
  arm(policy: ProviderRelayDetachPolicy | null): void {
    if (policy) {
      this.adopt(policy)
    }
    this.work = policy?.open ? this.openWorkAtDetach(policy.open) : null
    this.armed = this.work !== null
    this.waitingForLine = false
    this.lastActivityAt = Date.now()
    this.schedule(this.armed ? (this.policy?.idleStopMs ?? null) : null)
  }

  /** The work open when an app attached, which it can't see yet; null when none was tracked. */
  carriedWork(): { openWork?: Record<string, string[][]>; endedWork?: Record<string, string[][]> } {
    return {
      ...(this.carried ? { openWork: this.carried } : {}),
      ...(this.ended ? { endedWork: this.ended } : {})
    }
  }

  disarm(): void {
    // A takeover or a dropped stream tracked nothing new, so what the last app was handed still stands.
    this.carried = this.work?.keys() ?? this.carried
    // Ends are handed to one app: a window that tracked nothing (a dropped stream, a takeover)
    // passes none on, since that app may have acked them already.
    this.ended = this.work?.endedKeys() ?? null
    this.armed = false
    this.waitingForLine = false
    this.work = null
    this.clearTimer()
  }

  /** A transport-only line the policy names: neither forwarded, spooled nor counted as activity. */
  quiet(line: string): boolean {
    return isProviderRelayQuietLine(line, this.quietNames)
  }

  /** Called for every stdout line; attached it costs nothing, since the app counts the work. */
  observeAgentLine(line: string): void {
    this.lastActivityAt = Date.now()
    if (this.armed && this.work && this.reader) {
      this.reader.read(line).forEach((change) => this.work?.apply(change))
    }
    // Only an agent line can end a detached chat's work, so a busy one waits for it, not a timer.
    if (this.armed && this.waitingForLine) {
      this.waitingForLine = false
      this.schedule(this.policy?.idleStopMs ?? null)
    }
  }

  private adopt(policy: ProviderRelayDetachPolicy): void {
    if (JSON.stringify(policy.markers) !== JSON.stringify(this.policy?.markers)) {
      this.reader = new ProviderRelayWorkReader(policy.markers)
    }
    this.policy = policy
    this.quietNames = new Set(policy.quiet ?? [])
    this.host.workRequests?.(policy.workRequests ?? [])
  }

  private openWorkAtDetach(open: Record<string, string[][]>): ProviderRelayOpenWork {
    const work = new ProviderRelayOpenWork(open)
    const unacked = this.host.unacked()
    // Re-applying a line the app already counted is harmless; missing one is not.
    if (unacked === null) {
      work.overflow()
    }
    for (const { line } of unacked ?? []) {
      this.reader?.read(line).forEach((change) => work.apply(change))
    }
    return work
  }

  private schedule(delayMs: number | null): void {
    this.clearTimer()
    if (delayMs === null) {
      return
    }
    this.timer = setTimeout(() => this.check(), delayMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  check(): void {
    this.timer = null
    const policy = this.policy
    if (!this.armed || !this.work || !policy || policy.idleStopMs === null) {
      return
    }
    const quietFor = Date.now() - this.lastActivityAt
    if (quietFor < policy.idleStopMs) {
      this.schedule(policy.idleStopMs - quietFor)
      return
    }
    if (!this.host.live() || this.host.attached()) {
      return
    }
    if (this.work.busy || this.host.pendingCount() > 0) {
      this.waitingForLine = true
      return
    }
    this.armed = false
    this.host.log?.('relay-idle-stop', { quietMs: quietFor })
    this.host.stop()
  }
}
