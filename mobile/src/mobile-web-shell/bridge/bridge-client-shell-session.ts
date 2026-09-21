import { readShellSession, type BridgeShellSession } from './bridge-client-session'
import { bridgeRouteMoved } from './bridge-route-update'
import type {
  BridgeConnectionSnapshot,
  BridgeHostMessage,
  BridgeInitRoute
} from './bridge-envelope'

type InitMessage = Extract<BridgeHostMessage, { type: 'init' }>

/**
 * The session the page holds, and who it tells when `init` changes it.
 *
 * Its own module because it is the one piece of the client with a lifecycle rather than a value:
 * a second `init` for the same session updates it in place, a different one replaces it and takes
 * the requests and streams of the session before it, and each case has its own listeners to fire
 * in its own order. The client keeps the frames and the ports; this keeps what they are for.
 */
export type BridgeClientShellSession = {
  current: () => BridgeShellSession | null
  /** Reads one `init`: updates or replaces the session, then fires what that change is owed. */
  accept: (message: InitMessage) => void
  /** Fires once the session exists, immediately if it already does. */
  onReady: (listener: () => void) => () => void
  /** Fires when a second `init` for the session the page holds moved its route, and never else. */
  onRouteUpdate: (listener: (route: BridgeInitRoute | null) => void) => () => void
  /** Drops the session and every listener waiting on one, which `close` is the only caller of. */
  close: () => void
}

export function createBridgeClientShellSession(args: {
  /** The shell was rebuilt: everything the old session had in flight belongs to nobody now. */
  onReplaced: () => void
  /** Seats the connection cache from the frame, between the session moving and the listeners. */
  prime: (connection: BridgeConnectionSnapshot) => void
}): BridgeClientShellSession {
  let session: BridgeShellSession | null = null
  const readyListeners = new Set<() => void>()
  const routeUpdateListeners = new Set<(route: BridgeInitRoute | null) => void>()

  return {
    current: () => session,
    accept: (message) => {
      const held = session
      const update = held !== null && held.sessionId === message.sessionId ? held : null
      if (held !== null && update === null) {
        args.onReplaced()
      }
      // Updated in place for the session the page already holds, rebuilt for a different one. The
      // identity of what survives is the assertion: same object, so the storage snapshot the page
      // booted from is the one it keeps.
      session =
        update === null ? readShellSession(message) : { ...update, route: message.route ?? null }
      // Re-primed either way, because a second `init` is also how the page recovers a cache it has
      // refused a `state` frame into: the shell rebuilt under it publishes a generation the page's
      // own is newer than, and this frame is what puts the two back in step. A pane update carries
      // the same snapshot it already holds, which `prime` answers with no transition.
      args.prime(message.connection)
      for (const listener of readyListeners) {
        listener()
      }
      readyListeners.clear()
      // Only a route that moved is an update. The shell answers every `ready` with the route it
      // holds, and the page re-asks after a refused `state` frame, so publishing each of those
      // would hand the pane hook the route it is already on.
      if (update === null || !bridgeRouteMoved(update.route, session.route)) {
        return
      }
      for (const listener of routeUpdateListeners) {
        listener(session.route)
      }
    },
    onReady: (listener) => {
      if (session !== null) {
        listener()
        return () => undefined
      }
      readyListeners.add(listener)
      return () => {
        readyListeners.delete(listener)
      }
    },
    // Not fired on subscribe, and no replay: a listener that arrives late reads the route it wants
    // off `current`, and what this publishes is the fact that one moved.
    onRouteUpdate: (listener) => {
      routeUpdateListeners.add(listener)
      return () => {
        routeUpdateListeners.delete(listener)
      }
    },
    close: () => {
      session = null
      readyListeners.clear()
    }
  }
}
