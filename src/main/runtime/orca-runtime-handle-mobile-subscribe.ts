// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithApplyLayout } from './orca-runtime-apply-layout'

export class OrcaRuntimeWithHandleMobileSubscribe extends OrcaRuntimeWithApplyLayout {
  // Why: server-side auto-fit on mobile subscribe. The runtime is the single
  // source of truth — the mobile client just passes its viewport and the runtime
  // decides whether to resize. This eliminates the measure→RPC→resubscribe
  // pipeline that caused race conditions.
  //
  // Multi-mobile keying: each subscriber lives in `mobileSubscribers[ptyId]`'s
  // inner map under its own clientId. Phone B subscribing does not overwrite
  // phone A's record — both stay until each unsubscribes.
  //
  // Subscribe-in-desktop-mode rule: a subscribe with displayMode='desktop' is
  // a passive watch; it does NOT take the floor. The driver remains
  // `idle`/`desktop`. The lock banner is reserved for actual mobile
  // interaction (input/resize/setDisplayMode/auto-or-phone subscribe).
  async handleMobileSubscribe(
    ptyId: string,
    clientId: string,
    viewport?: { cols: number; rows: number }
  ): Promise<boolean> {
    try {
      return await this.handleMobileSubscribeInternal(ptyId, clientId, viewport)
    } finally {
      // Every subscribe path mutates mobileSubscribers — resync the daemon
      // background mark once, whatever branch returned.
      this.notifyRemoteTerminalViewPresenceChanged(ptyId)
    }
  }
}
