import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

// Forward replacement dial states before binding; connected stays with migration so UI cannot advertise a session still rejecting requests.
const DIAL_PHASES: ConnectionState[] = ['connecting', 'handshaking', 'reconnecting']

export type MigrationDialStateForwarder = {
  forwarded: () => boolean
  stop: () => void
}

// Forward only from idle until connected; active/reconnecting sessions already own state, and competing publishers would flicker.
function canForward(started: boolean, state: ConnectionState, suspended: boolean): boolean {
  if (suspended) {
    return true
  }
  return started ? state !== 'connected' : state === 'disconnected'
}

export function forwardMigrationDialState(args: {
  session: RpcClient
  snapshot: () => { state: ConnectionState; suspended: boolean }
  publish: (state: ConnectionState) => void
}): MigrationDialStateForwarder {
  let started = false
  let stopped = false
  const forward = (next: ConnectionState): void => {
    if (stopped || !DIAL_PHASES.includes(next)) {
      return
    }
    const { state, suspended } = args.snapshot()
    if (!canForward(started, state, suspended)) {
      return
    }
    started = true
    args.publish(next)
  }
  const unsubscribe = args.session.onStateChange(forward)
  // Why: a relay session starts in connecting without publishing it; idle would read Disconnected until the hello.
  forward(args.session.getState())
  return {
    forwarded: () => started,
    stop: () => {
      stopped = true
      unsubscribe()
    }
  }
}
