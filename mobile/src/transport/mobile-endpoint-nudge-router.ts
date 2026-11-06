import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ForegroundNudgeReason } from './types'

export class MobileEndpointNudgeRouter {
  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      controller: RelayReconnectController
      isStopped: () => boolean
      isForeground: () => boolean
      setForeground: (foreground: boolean) => void
      scheduleDirectProbe: () => void
    }
  ) {}

  nudge(reason: ForegroundNudgeReason): void {
    const { args } = this
    if (args.isStopped()) {
      return
    }
    if (!args.isForeground()) {
      // Background handoffs must not reopen billed relay splices; focus/resume imply visibility even before AppState catches up.
      if (reason === 'network-change') {
        return
      }
      args.setForeground(true)
    }
    args.controller.handleActiveNudge(args.logical, reason)
    args.scheduleDirectProbe()
  }
}
