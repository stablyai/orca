import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'

// Why: a replacement session publishes these to nobody until migrateTo binds it, so a
// suspended client shows grey for the whole dial (S2). 'connected' stays excluded — the
// migration tail owns it, and forwarding it early would advertise a session that still
// rejects requests.
const DIAL_PHASES: ConnectionState[] = ['connecting', 'handshaking', 'reconnecting']

export type MigrationDialStateForwarder = {
  forwarded: () => boolean
  stop: () => void
}

// Why: start only from an idle logical client and abandon the moment anything else
// publishes 'connected' — make-before-break replacement dials (lease rotation, the
// supervisor's suspectActive recovery) must never blink the dot on their way through.
// 'reconnecting' is deliberately not a start state: the previous session's retry loop
// is still bound and cycling, so two publishers would fight over a dot that is already
// amber. That case is served by the pending path label instead, not by forwarding.
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
  const unsubscribe = args.session.onStateChange((next) => {
    if (stopped || !DIAL_PHASES.includes(next)) {
      return
    }
    const { state, suspended } = args.snapshot()
    if (!canForward(started, state, suspended)) {
      return
    }
    started = true
    args.publish(next)
  })
  return {
    forwarded: () => started,
    stop: () => {
      stopped = true
      unsubscribe()
    }
  }
}
