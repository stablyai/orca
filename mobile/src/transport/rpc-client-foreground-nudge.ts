import { isStaleForegroundDial } from './rpc-stale-dial'
import type { ConnectionState } from './types'

// Why: iOS/Android can kill the TCP path while backgrounded, so a resume probes or redials.
export function nudgeRpcClientForeground(args: {
  // Why: abandoning a stale dial moves the state, so the redial branch must re-read it.
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  dialAgeMs: number
  hasReconnectTimer: () => boolean
  probeLiveness: () => void
  abandonDial: () => boolean
  redial: (keepTimer: boolean) => void
}): void {
  if (args.getState() === 'connected') {
    console.log('[net] foreground — probing live connection')
    args.probeLiveness()
    return
  }
  let abandoned = false
  if (isStaleForegroundDial(args.getState(), args.dialAgeMs)) {
    console.log('[net] foreground — abandoning stale dial', {
      state: args.getState(),
      dialAgeMs: args.dialAgeMs
    })
    abandoned = args.abandonDial()
  }
  if (args.getState() === 'reconnecting') {
    console.log('[net] foreground — restarting reconnect loop', {
      attempt: args.getReconnectAttempt(),
      hadTimer: args.hasReconnectTimer()
    })
    args.redial(!abandoned)
  }
}
