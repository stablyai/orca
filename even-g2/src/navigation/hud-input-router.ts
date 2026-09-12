// Unit 5: wires bridge.onRawEvent -> normalizer -> reduceHudInput, then applies the resulting
// effects through injected ports. Root double-tap exit + exit-dialog armed-flag management
// live in hud-navigation.ts's reducer; this module just drives it off real (or fake) events.
import type { GlassesBridge, GlassesRawEvent } from '../glasses/glasses-bridge'
import {
  createGlassesEventNormalizer,
  type GlassesEventNormalizerOptions
} from '../glasses/glasses-event-normalization'
import type { HudState, HudStore } from '../state/hud-store'
import type { HudInput, NavContext, NavEffect } from './nav-contract'
import { askQuickActionToKeys } from './ask-quick-action'
import { reduceHudInput } from './hud-navigation'

/**
 * Effect sinks the router calls into. Owned/implemented outside Unit 5 (integration wiring)
 * against real RpcPort/HostProfileStore/etc; sendAskAnswer receives the already-encoded key
 * sequence (spec S7: digit -> "<n>\r", enter -> "\r", escape -> "\x1b") so ports never need to
 * know about AskQuickAction shapes.
 */
export type NavPorts = {
  shutdownDialog(): void
  connectHost(hostId: string): void
  openTerminalTail(worktreeId: string): void
  closeTerminalTail(terminalId: string): void
  sendAskAnswer(hostId: string, worktreeId: string, notificationId: string, keys: string): void
  refreshDashboard(): void
  pausePolling(): void
  resumePolling(): void
  disconnectHost(): void
  // Optional (additive): older port implementations no-op these rather than fail to typecheck.
  // invalidateRender -> HudRenderQueue.invalidate(); reopenTerminalTail -> re-subscribe after
  // an abnormalExit tore the stream down (see nav-contract.ts's NavEffect union).
  invalidateRender?(): void
  reopenTerminalTail?(worktreeId: string): void
}

export type HudInputRouterOptions = {
  bridge: GlassesBridge
  store: HudStore
  ports: NavPorts
  /** Builds the reducer's read-only lookups from current state (hud-store selectors). */
  buildContext(state: HudState): NavContext
  normalizerOptions?: GlassesEventNormalizerOptions
}

export class HudInputRouter {
  private readonly normalize: (raw: GlassesRawEvent) => HudInput | null
  private unsubscribeBridge: (() => void) | null = null

  constructor(private readonly options: HudInputRouterOptions) {
    this.normalize = createGlassesEventNormalizer(options.normalizerOptions)
  }

  /** Subscribes to the bridge; returns an unsubscribe fn (also callable as stop()). */
  start(): () => void {
    this.unsubscribeBridge = this.options.bridge.onRawEvent((raw) => this.handleRaw(raw))
    return () => this.stop()
  }

  stop(): void {
    this.unsubscribeBridge?.()
    this.unsubscribeBridge = null
  }

  private handleRaw(raw: GlassesRawEvent): void {
    const input = this.normalize(raw)
    if (input !== null) {
      this.dispatch(input)
    }
  }

  /** Exposed directly so tests can drive the reducer without a real/fake bridge event. */
  dispatch(input: HudInput): void {
    const state = this.options.store.getState()
    const ctx = this.options.buildContext(state)
    const { state: nextNav, effects } = reduceHudInput(state.nav, input, ctx)

    if (nextNav !== state.nav) {
      this.options.store.update((s) => ({ ...s, nav: nextNav }))
    }
    for (const effect of effects) {
      this.applyEffect(effect)
    }
  }

  private applyEffect(effect: NavEffect): void {
    const ports = this.options.ports
    switch (effect.kind) {
      case 'requestShutdownDialog':
        return ports.shutdownDialog()
      case 'connectHost':
        return ports.connectHost(effect.hostId)
      case 'openTerminalTail':
        return ports.openTerminalTail(effect.worktreeId)
      case 'closeTerminalTail':
        return ports.closeTerminalTail(effect.terminalId)
      case 'sendAskAnswer':
        return ports.sendAskAnswer(
          effect.hostId,
          effect.worktreeId,
          effect.notificationId,
          askQuickActionToKeys(effect.option)
        )
      case 'refreshDashboard':
        return ports.refreshDashboard()
      case 'pausePolling':
        return ports.pausePolling()
      case 'resumePolling':
        return ports.resumePolling()
      case 'disconnectHost':
        return ports.disconnectHost()
      case 'invalidateRender':
        return ports.invalidateRender?.()
      case 'reopenTerminalTail':
        return ports.reopenTerminalTail?.(effect.worktreeId)
    }
  }
}
