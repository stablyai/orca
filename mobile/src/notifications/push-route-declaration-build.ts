import type { MobilePushToken } from './push-token'
import {
  currentRoute,
  reconcileRoute,
  type RouteCell,
  type RouteResult
} from './push-route-reconciliation'
import { routeKeyPreparationSnapshotForTests } from './push-route-key-preparation'
export { mobilePushRouteKey, type RouteKeyPreparation } from './push-route-key-preparation'

export type RouteReconciliation = {
  readonly result: Promise<RouteResult>
  release(): void
}
let builder: RouteCell | undefined
let latestBuild: RouteCell | undefined
function finishBuild(cell: RouteCell, result: RouteResult): void {
  const resolve = cell.resolve
  cell.pendingWake = false
  cell.current = undefined
  cell.token = undefined
  cell.resolve = undefined
  cell.key?.release()
  cell.key = undefined
  cell.keypair = undefined
  cell.body = undefined
  cell.catalog = undefined
  cell.version = undefined
  cell.floor = undefined
  cell.limited = undefined
  cell.http?.abort()
  cell.http = undefined
  clearTimeout(cell.timer)
  cell.timer = undefined
  cell.resume?.()
  cell.resume = undefined
  if (latestBuild === cell) {
    latestBuild = undefined
  }
  resolve?.(result)
}
async function runBuilder(cell: RouteCell): Promise<void> {
  try {
    let result: RouteResult
    do {
      cell.pendingWake = false
      result = await reconcileRoute(cell)
    } while (
      currentRoute(cell) &&
      cell.pendingWake &&
      result.status !== 'accepted' &&
      !(result.status === 'refused' && result.reason === 'capacity')
    )
    finishBuild(cell, currentRoute(cell) ? result : { status: 'retired' })
  } catch {
    finishBuild(cell, { status: 'unavailable' })
  } finally {
    if (builder === cell) {
      builder = undefined
    }
    startLatestBuild()
  }
}
function startLatestBuild(): void {
  if (builder || !latestBuild) {
    return
  }
  builder = latestBuild
  latestBuild = undefined
  if (currentRoute(builder)) {
    void runBuilder(builder)
  } else {
    finishBuild(builder, { status: 'retired' })
    builder = undefined
  }
}
export function preparePushRouteReconciliation(
  token: MobilePushToken,
  isCurrent: () => boolean
): RouteReconciliation {
  if (builder) {
    finishBuild(builder, { status: 'retired' })
  }
  if (latestBuild) {
    finishBuild(latestBuild, { status: 'retired' })
  }
  const deferred = Promise.withResolvers<RouteResult>()
  const cell: RouteCell = { token, current: isCurrent, resolve: deferred.resolve }
  latestBuild = cell
  startLatestBuild()
  return {
    result: deferred.promise,
    release() {
      finishBuild(cell, { status: 'retired' })
    }
  }
}
export function wakeRouteReconciliation(): void {
  const cell = latestBuild ?? builder
  if (cell && currentRoute(cell)) {
    cell.pendingWake = true
  }
}
export function pushRoutePreparationSnapshotForTests() {
  return {
    ...routeKeyPreparationSnapshotForTests(),
    builder: Number(builder !== undefined),
    latest: Number(latestBuild !== undefined),
    builderCallables:
      Number(builder?.current !== undefined) + Number(latestBuild?.current !== undefined),
    builderPayloads:
      Number(builder?.token !== undefined) + Number(latestBuild?.token !== undefined),
    builderBodies: Number(builder?.body !== undefined) + Number(latestBuild?.body !== undefined),
    routeHttp: Number(builder?.http !== undefined),
    routeTimers: Number(builder?.timer !== undefined)
  }
}
