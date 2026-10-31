import type { MobilePushToken } from './push-token'
import {
  preparePushRouteReconciliation,
  wakeRouteReconciliation,
  type RouteReconciliation
} from './push-route-declaration-build'
import {
  clearRouteCatalog,
  commitRouteCatalog,
  freshRouteCatalog,
  routeCatalogIdentity,
  type RouteCatalogCommit
} from './push-route-catalog'
import { PUSH_ROUTE_GATEWAY } from './push-route-http'
export { mobilePushRouteKey } from './push-route-declaration-build'

type Desired = { token: MobilePushToken; intent: number }
type Wake = 'input' | 'catalog' | 'renewal' | 'registration'
export type PushRoutePublication = {
  wake(reason: Wake): void
  registered(gatewayOrigin?: string): void
  stop(): void
}
let attached: PushRoutePublication | undefined
let catalogNotification = false
export function refreshPushRoutes(value: RouteCatalogCommit): void {
  if (!attached) {
    return
  }
  commitRouteCatalog(value)
  if (!catalogNotification) {
    catalogNotification = true
    queueMicrotask(() => {
      catalogNotification = false
      attached?.wake('catalog')
    })
  }
}
export function startPushRoutePublication(
  readDesired: () => Desired | undefined
): PushRoutePublication {
  attached?.stop()
  let active = true
  let identity: string | undefined
  let generation = 0
  let accepted = false
  let due = false
  let preparation: RouteReconciliation | undefined
  let membership: Set<string> | undefined
  const currentIdentity = () => JSON.stringify(readDesired())
  const valid = (candidate: number) =>
    active &&
    candidate === generation &&
    identity === currentIdentity() &&
    readDesired() !== undefined
  function retire(): void {
    generation++
    preparation?.release()
    preparation = undefined
    accepted = false
    due = false
  }
  function start(): void {
    preparation?.release()
    accepted = false
    const desired = readDesired()
    if (!desired) {
      return
    }
    const candidate = ++generation
    const handle = preparePushRouteReconciliation(desired.token, () => valid(candidate))
    preparation = handle
    void handle.result.then((result) => {
      if (!valid(candidate) || preparation !== handle) {
        return
      }
      preparation = undefined
      membership = routeCatalogIdentity()
      accepted = result.status === 'accepted'
      if (due) {
        due = false
        freshRouteCatalog()
        start()
      }
    })
  }
  const handle: PushRoutePublication = {
    wake(reason): void {
      if (!active) {
        return
      }
      const desired = readDesired()
      const next = currentIdentity()
      if (!desired) {
        retire()
        identity = undefined
        clearRouteCatalog()
        return
      }
      const catalog = reason === 'catalog' ? routeCatalogIdentity() : membership
      if (identity !== next || (reason === 'catalog' && catalog !== membership)) {
        retire()
        identity = next
        membership = catalog
        start()
      } else if (reason === 'renewal') {
        if (preparation) {
          due = true
        } else {
          freshRouteCatalog()
          start()
        }
      } else if (reason === 'registration' && !accepted) {
        if (preparation) {
          wakeRouteReconciliation()
        } else {
          start()
        }
      }
    },
    registered(gatewayOrigin): void {
      if (gatewayOrigin === PUSH_ROUTE_GATEWAY) {
        handle.wake('registration')
      }
    },
    stop(): void {
      active = false
      retire()
      if (attached === handle) {
        attached = undefined
        clearRouteCatalog()
      }
    }
  }
  attached = handle
  return handle
}
