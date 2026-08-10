import { MobileRelayFocusProbe } from './mobile-relay-focus-probe'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ForegroundNudgeReason } from './types'

// Routes attention/network nudges: focus and app-resume probe a healthy relay,
// a network change replaces it make-before-break, everything else re-enters recovery.
export class MobileEndpointNudgeRouter {
  private readonly focusProbe: MobileRelayFocusProbe

  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      controller: RelayReconnectController
      now: () => number
      isStopped: () => boolean
      isForeground: () => boolean
      setForeground: (foreground: boolean) => void
      replaceRelay: () => void
      recoverAfterDeadProbe: (detail: string) => void
      scheduleDirectProbe: () => void
    }
  ) {
    this.focusProbe = new MobileRelayFocusProbe({
      logical: args.logical,
      now: args.now,
      canProbe: () => !args.isStopped() && args.isForeground(),
      onDead: args.recoverAfterDeadProbe
    })
  }

  nudge(reason: ForegroundNudgeReason): void {
    const { args } = this
    if (args.isStopped()) {
      return
    }
    if (!args.isForeground()) {
      // Why: a background network flap must not re-open a billed relay splice;
      // focus/app-resume imply the app is visible even if AppState lags.
      if (reason === 'network-change') {
        return
      }
      args.setForeground(true)
    }
    const verdict = args.controller.handleActiveNudge(args.logical, reason)
    if (verdict === 'probe') {
      void this.focusProbe.probe()
    } else if (verdict === 'replace') {
      args.replaceRelay()
    }
    args.scheduleDirectProbe()
  }
}
