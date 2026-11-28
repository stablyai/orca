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
const RETIRED_CONFIRM_DELAYS_MS = [50, 100, 250, 500, 1_000, 2_000]

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
    // Refused while an older generation decided past the fence: route again once it has answered.
    const decision = target && target !== 'any' ? this.preRpc.pendingDecision(target) : undefined
    if (decision) {
      await decision
      return true
    }
    const held = this.options.legacy().filter((adapter) => this.modes.get(adapter) === 'held')
    // Only the generation the spawn reached can have refused it before its close arrives.
    const settled = await Promise.all(
      held.map((adapter) => this.confirmRetired(adapter, target === 'any' || adapter === target))
    )
    return settled.includes(true) || this.options.legacy().length < generationsAtStart
  }

  private async hold(adapter: DaemonPtyAdapter): Promise<void> {
    this.modes.set(adapter, 'asking')
    const result = await adapter.askRetireWhenIdle(this.options.current().protocolVersion)
    if (this.disposed || !this.isRetirableLegacy(adapter)) {
      return
    }
    if (result === 'unanswered') {
      // The next exit, discovery or reattach asks again.
      this.modes.delete(adapter)
      return
    }
    if (result === 'unsupported') {
      this.modes.set(adapter, 'pre-rpc')
      this.preRpc.noteActivity(adapter)
      return
    }
    this.adoptHeld(adapter)
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
      await new Promise((resolve) => setTimeout(resolve, delayMs).unref?.())
    }
    if (!this.disposed && this.modes.get(adapter) === 'held' && !adapter.isHeldForRetirement()) {
      // Still unproven: endpoint-loss handling keeps it, and the next activity looks again.
      this.modes.delete(adapter)
    }
    return false
  }

  noteAll(): void {
    for (const adapter of this.options.legacy()) {
      this.noteActivity(adapter)
    }
  }

  dispose(): void {
    this.disposed = true
    this.preRpc.dispose()
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
