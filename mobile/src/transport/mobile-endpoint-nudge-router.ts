import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ForegroundNudgeReason } from './types'

// Routes attention/network nudges: focus and app-resume probe a healthy relay,
// a network change replaces it make-before-break, everything else re-enters recovery.
export class MobileEndpointNudgeRouter {
  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      controller: RelayReconnectController
      isStopped: () => boolean
      isForeground: () => boolean
      setForeground: (foreground: boolean) => void
      replaceRelay: () => void
      scheduleDirectProbe: () => void
    }
  ) {}

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
    if (verdict === 'replace') {
      args.replaceRelay()
    }
    args.scheduleDirectProbe()
  }
}
