import {
  mobileSessionRouteTarget,
  type MobileSessionRouteParams
} from '../session/mobile-session-route'

export type HostStackResetAction = Readonly<{
  type: 'RESET'
  payload: Readonly<{
    index: number
    routes: readonly Readonly<{ name: string; params: Readonly<Record<string, string>> }>[]
  }>
}>

/** Replaces the whole host stack with `[host list]` or `[host list, session]`, so a switch —
 *  even to another machine — leaves exactly one Back between the user and that host's list. */
export function hostStackResetAction(
  hostId: string,
  session?: Omit<MobileSessionRouteParams, 'hostId'>
): HostStackResetAction {
  const hostRoute = { name: '[hostId]/index', params: { hostId } }
  if (!session) {
    return { type: 'RESET', payload: { index: 0, routes: [hostRoute] } }
  }
  return {
    type: 'RESET',
    payload: { index: 1, routes: [hostRoute, mobileSessionRouteTarget({ ...session, hostId })] }
  }
}

type RootRoute = Readonly<{ key?: string; name: string }>

export type RootStackState = Readonly<{ index: number; routes: readonly RootRoute[] }>

export type RootHostSwitchAction = Readonly<{
  type: 'RESET'
  payload: Readonly<{
    index: number
    routes: readonly (RootRoute | Readonly<{ name: 'h'; state: HostStackResetAction['payload'] }>)[]
  }>
}>

/** Swaps the root's focused `h` route for a new one that already holds the target host's stack.
 *  Why: `HostProtocolGate` unmounts the host stack while a newly focused host's status is
 *  pending, which would discard a reset dispatched into it; a fresh `h` route keeps the stack
 *  on the route itself until the gate mounts it. */
export function rootHostSwitchAction(
  root: RootStackState,
  hostId: string,
  session?: Omit<MobileSessionRouteParams, 'hostId'>
): RootHostSwitchAction | null {
  if (root.routes[root.index]?.name !== 'h') {
    return null
  }
  return {
    type: 'RESET',
    payload: {
      index: root.index,
      routes: [
        ...root.routes.slice(0, root.index),
        { name: 'h', state: hostStackResetAction(hostId, session).payload }
      ]
    }
  }
}
