import type { ConnectionState } from './types'

export function canRecoverMobileRelay(args: {
  stopped: boolean
  foreground: boolean
  operationInFlight: boolean
  hasBundle: boolean
  hasRelay: boolean
  forceReplacement: boolean
  allowDirectRace: boolean
  state: ConnectionState
  needsRecovery: (state: ConnectionState) => boolean
}): boolean {
  return (
    !args.stopped &&
    args.foreground &&
    !args.operationInFlight &&
    args.hasBundle &&
    args.hasRelay &&
    (args.forceReplacement || args.allowDirectRace || args.needsRecovery(args.state))
  )
}
