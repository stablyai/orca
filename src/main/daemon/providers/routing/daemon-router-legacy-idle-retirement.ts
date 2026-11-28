import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import {
  DaemonConnectionLostError,
  isDaemonEndpointGoneError,
  TerminalSessionOwnerUnverifiedError
} from '../../protocol/daemon-errors'
import {
  DaemonRouterPreRpcRetirement,
  type PreRpcRetirementTiming
} from './daemon-router-pre-rpc-retirement'

/** A retiring generation closes, then exits; both are proven within a few of these. */
const RETIRED_CONFIRM_DELAYS_MS = [0, 50, 100, 250, 500, 1_000, 2_000]
/** Bounded: a generation that never answers stays as today, until quit. */
const ASK_RETRY_DELAYS_MS = [5_000, 30_000, 120_000]

export type LegacyIdleRetirementOptions = {
  current: () => DaemonPtyAdapter
  legacy: () => readonly DaemonPtyAdapter[]
  /** Forgets a generation that accepted retirement. */
  drop: (adapter: DaemonPtyAdapter) => void
  timing?: PreRpcRetirementTiming
}

/**
 * Retires an older generation once it owns nothing. Held generations (`retireWhenIdle`) decide by
 * themselves, atomically, and are forgotten once their endpoint and process are gone. Older ones
 * take the transitional pre-RPC path.
 */
export class DaemonRouterLegacyIdleRetirement {
  private readonly modes = new WeakMap<DaemonPtyAdapter, 'asking' | 'held' | 'pre-rpc'>()
  private readonly lostListeners = new Map<DaemonPtyAdapter, () => void>()
  private readonly askAttempts = new WeakMap<DaemonPtyAdapter, number>()
  private readonly askTimers = new Map<DaemonPtyAdapter, ReturnType<typeof setTimeout>>()
  private readonly preRpc: DaemonRouterPreRpcRetirement
  private disposed = false

  constructor(private readonly options: LegacyIdleRetirementOptions) {
    this.preRpc = new DaemonRouterPreRpcRetirement({
      applies: (adapter) =>
        this.isRetirableLegacy(adapter) && this.modes.get(adapter) === 'pre-rpc',
      forget: (adapter) => this.forget(adapter),
      timing: options.timing
    })
  }

  admitReattach(): Promise<() => void> {
    return this.preRpc.admitReattach()
  }

  /** An exit, discovery or reattach on the generation. */
  noteActivity(adapter: DaemonPtyAdapter): void {
    if (this.disposed || !this.isRetirableLegacy(adapter)) {
      return
    }
    // Accepted under another router (a restart carries adapters over): it is already leaving.
    if (adapter.hasRetiredForIdle()) {
      this.forget(adapter)
      return
    }
    const mode = this.modes.get(adapter)
    if (mode === undefined && adapter.wasAskedToRetireWhenIdle()) {
      this.adoptHeld(adapter)
      void this.confirmRetired(adapter, false)
    } else if (mode === undefined) {
      void this.hold(adapter)
    } else if (mode === 'held' && !adapter.isHeldForRetirement()) {
      void this.confirmRetired(adapter, false)
    } else if (mode === 'pre-rpc') {
      this.preRpc.noteActivity(adapter)
    }
  }

  /** After a spawn failed: true when a held generation retired under it (already forgotten, or now). */
  async settleHeldRetirements(
    error: unknown,
    generationsAtStart: number,
    target: DaemonPtyAdapter | 'any' | undefined
  ): Promise<boolean> {
    if (!mayComeFromRetirement(error)) {
      return false
    }
    const reached = target && target !== 'any' ? target : undefined
    // Refused while an older generation decided past the fence: route again once it has answered.
    const decision = reached ? this.preRpc.pendingDecision(reached) : undefined
    if (reached && decision) {
      await decision
      // Its own admission refused the spawn before sending it, or it retired: either way nothing ran there.
      return !this.options.legacy().includes(reached) || isAdmissionRefusal(error)
    }
    const held = this.options.legacy().filter((adapter) => this.modes.get(adapter) === 'held')
    // Only the generation the spawn reached can have refused it before its close arrives.
    const settled = await Promise.all(
      held.map((adapter) => this.confirmRetired(adapter, target === 'any' || adapter === target))
    )
    // A spawn sent to an older generation replays only once that generation itself is proven retired.
    if (reached) {
      return !this.options.legacy().includes(reached)
    }
    // Nothing was sent (owner resolution failed) or it was attach-only, which never creates.
    return settled.includes(true) || this.options.legacy().length < generationsAtStart
  }

  private async hold(adapter: DaemonPtyAdapter): Promise<void> {
    this.modes.set(adapter, 'asking')
    const result = await adapter.askRetireWhenIdle(this.options.current().protocolVersion)
    if (this.disposed || !this.isRetirableLegacy(adapter)) {
      return
    }
    if (result === 'unanswered') {
      this.modes.delete(adapter)
      this.askAgainSoon(adapter)
      return
    }
    this.askAttempts.delete(adapter)
    if (result === 'unsupported') {
      this.modes.set(adapter, 'pre-rpc')
      this.preRpc.noteActivity(adapter)
      return
    }
    this.adoptHeld(adapter)
  }

  /** A few spaced retries after an unanswered ask; later exits, discovery or reattaches ask again too. */
  private askAgainSoon(adapter: DaemonPtyAdapter): void {
    const attempt = this.askAttempts.get(adapter) ?? 0
    const delayMs = ASK_RETRY_DELAYS_MS[attempt]
    if (delayMs === undefined || this.askTimers.has(adapter)) {
      return
    }
    this.askAttempts.set(adapter, attempt + 1)
    const timer = setTimeout(() => {
      this.askTimers.delete(adapter)
      this.noteActivity(adapter)
    }, delayMs)
    timer.unref?.()
    this.askTimers.set(adapter, timer)
  }

  private adoptHeld(adapter: DaemonPtyAdapter): void {
    this.modes.set(adapter, 'held')
    if (!this.lostListeners.has(adapter)) {
      this.lostListeners.set(
        adapter,
        adapter.onConnectionLost(() => void this.confirmRetired(adapter, false))
      )
    }
  }

  /** A held connection only closes when the daemon retires, stops, or the link drops. */
  private async confirmRetired(adapter: DaemonPtyAdapter, awaitClose: boolean): Promise<boolean> {
    for (const delayMs of RETIRED_CONFIRM_DELAYS_MS) {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.())
      }
      if (this.disposed || this.modes.get(adapter) !== 'held') {
        return false
      }
      const verdict = await adapter.confirmRetiredWhenIdle()
      if (verdict === 'retired') {
        this.forget(adapter)
        return true
      }
      // Reconnected, here or by another path: a new connection keeps the daemon alive until asked again.
      if (
        verdict === 'reconnected' ||
        (verdict === 'connected' && !adapter.isHeldForRetirement())
      ) {
        void this.hold(adapter)
        return false
      }
      // A refused spawn can beat the close that follows a retirement.
      if (verdict === 'connected' && !awaitClose) {
        return false
      }
    }
    // Still unproven, but still tracked: its next close, reconnect or activity looks again.
    return false
  }

  noteAll(): void {
    // A copy: an adapter already retired is removed from the list while this walks it.
    for (const adapter of this.options.legacy().slice()) {
      this.noteActivity(adapter)
    }
  }

  dispose(): void {
    this.disposed = true
    this.preRpc.dispose()
    for (const timer of this.askTimers.values()) {
      clearTimeout(timer)
    }
    this.askTimers.clear()
    for (const stop of this.lostListeners.values()) {
      stop()
    }
    this.lostListeners.clear()
  }

  /** The current generation is never retired here, even when it is empty. */
  private isRetirableLegacy(adapter: DaemonPtyAdapter): boolean {
    const current = this.options.current()
    return (
      adapter !== current &&
      adapter.protocolVersion < current.protocolVersion &&
      adapter.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION &&
      this.options.legacy().includes(adapter)
    )
  }

  private forget(adapter: DaemonPtyAdapter): void {
    this.lostListeners.get(adapter)?.()
    this.lostListeners.delete(adapter)
    this.options.drop(adapter)
  }
}

/** Refusals a retiring generation gives work that reached it after it decided. */
function mayComeFromRetirement(error: unknown): boolean {
  return (
    error instanceof DaemonConnectionLostError ||
    error instanceof TerminalSessionOwnerUnverifiedError ||
    isDaemonEndpointGoneError(error) ||
    (error instanceof Error &&
      (error.message.includes('temporarily unavailable') ||
        error.message.includes('decommissioning')))
  )
}

/** The generation's own admission refused the spawn, so it never sent it. */
function isAdmissionRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes('decommissioning')
}
