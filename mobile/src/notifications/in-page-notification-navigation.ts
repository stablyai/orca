import { useEffect } from 'react'
import type { BridgeInitRoute } from '../mobile-web-shell/bridge/bridge-envelope'
import type { BridgeClearableRouteParam } from '../mobile-web-shell/bridge/bridge-route-update'
import { isHostRouteOf } from '../mobile-web-shell/page-route-policy'
import { pageRouteWorkspace } from '../mobile-web-shell/page-storage-keys'
import { readLastVisitedWorktreeOnHost } from '../worktree/last-visited-worktree-by-host'
import { LAST_VISITED_WORKTREE_STORAGE_KEY } from '../worktree/last-visited-worktree-repo'
import type { NotificationViewingWorkspace } from './notification-viewing-policy'

type InPageNotificationTarget = {
  worktreeId?: string
  paneKey?: string
  executionHost?: string
}

type InPageNotificationHandler = (target: InPageNotificationTarget) => boolean

const handlersByHostId = new Map<string, InPageNotificationHandler>()
const activeInPageHostKeys = new Set<string>()
const mountedHostBridgesByKey = new Map<string, number>()
const ENCODED_TARGET_PREFIX = 'orca-nav:'
let nextNavigationSeq = 0

function normalizeHostKey(hostId: string): string {
  try {
    return decodeURIComponent(hostId)
  } catch {
    return hostId
  }
}

export function registerInPageNotificationNavigation(
  hostId: string,
  handler: InPageNotificationHandler
): () => void {
  const key = normalizeHostKey(hostId)
  handlersByHostId.set(key, handler)
  return () => {
    if (handlersByHostId.get(key) === handler) {
      handlersByHostId.delete(key)
    }
  }
}

export function dispatchInPageNotificationNavigation(
  target: InPageNotificationTarget & { hostId: string }
): boolean {
  const handler = handlersByHostId.get(normalizeHostKey(target.hostId))
  if (!handler) {
    return false
  }
  return handler({
    worktreeId: target.worktreeId,
    paneKey: target.paneKey,
    executionHost: target.executionHost
  })
}

export function encodeInPageNotificationTarget(target: InPageNotificationTarget): string {
  nextNavigationSeq += 1
  return `${ENCODED_TARGET_PREFIX}${JSON.stringify({
    ...(target.worktreeId ? { w: target.worktreeId } : {}),
    ...(target.paneKey ? { p: target.paneKey } : {}),
    ...(target.executionHost ? { e: target.executionHost } : {}),
    n: nextNavigationSeq
  })}`
}

export function decodeInPageNotificationTarget(raw: string): InPageNotificationTarget {
  if (!raw.startsWith(ENCODED_TARGET_PREFIX)) {
    return { paneKey: raw }
  }
  try {
    const parsed = JSON.parse(raw.slice(ENCODED_TARGET_PREFIX.length)) as {
      w?: unknown
      p?: unknown
      e?: unknown
    }
    return {
      ...(typeof parsed.w === 'string' && parsed.w.length > 0 ? { worktreeId: parsed.w } : {}),
      ...(typeof parsed.p === 'string' && parsed.p.length > 0 ? { paneKey: parsed.p } : {}),
      ...(typeof parsed.e === 'string' && parsed.e.length > 0 ? { executionHost: parsed.e } : {})
    }
  } catch {
    return { paneKey: raw }
  }
}

export function noteInPageStorageWrite(
  hostId: string,
  key: string,
  value: string | null,
  writeStorage: (key: string, value: string | null) => void,
  setViewingWorkspace: (value: NotificationViewingWorkspace | null) => void
): void {
  writeStorage(key, value)
  if (key === LAST_VISITED_WORKTREE_STORAGE_KEY && value !== null) {
    const visited = readLastVisitedWorktreeOnHost(value, hostId)
    if (visited) {
      if (visited.inSession === false) {
        activeInPageHostKeys.delete(normalizeHostKey(hostId))
        setViewingWorkspace(null)
        return
      }
      activeInPageHostKeys.add(normalizeHostKey(hostId))
      setViewingWorkspace({
        hostId,
        worktreeId: visited.worktreeId,
        ...(visited.executionHost ? { executionHost: visited.executionHost } : {}),
        ...(visited.paneKey ? { paneKey: visited.paneKey } : {})
      })
    }
  }
}

export function noteInPageBackClaim(
  claimed: boolean,
  _routePathname: string,
  _hostId: string,
  reportPageBackClaim: (claimed: boolean) => void,
  _setViewingWorkspace: (value: NotificationViewingWorkspace | null) => void
): void {
  reportPageBackClaim(claimed)
}

export function noteInPageRouteParamClear(
  param: BridgeClearableRouteParam,
  value: string,
  route: BridgeInitRoute,
  publishRoute: (route: BridgeInitRoute) => void,
  onRouteParamClear?: (param: BridgeClearableRouteParam, value: string) => void
): void {
  onRouteParamClear?.(param, value)
  if (param === 'paneKey' && route.params?.paneKey !== value) {
    publishRoute(route)
  }
}

export function useInPageNotificationBridge(params: {
  pageReady: boolean
  overlay: boolean
  ownsHostArea: boolean
  hostId: string
  isFocused?: () => boolean
  publishRoute: (route: BridgeInitRoute) => void
  route: BridgeInitRoute
  setViewingWorkspace: (value: NotificationViewingWorkspace | null) => void
}): void {
  const {
    pageReady,
    overlay,
    ownsHostArea,
    hostId,
    isFocused,
    publishRoute,
    route,
    setViewingWorkspace
  } = params
  const handlesHostNavigation =
    !overlay &&
    (pageRouteWorkspace(route.pathname) !== null ||
      ownsHostArea ||
      isHostRouteOf(route.pathname, hostId))
  const enabled = pageReady && handlesHostNavigation
  useEffect(() => {
    if (!handlesHostNavigation) {
      return
    }
    const key = normalizeHostKey(hostId)
    mountedHostBridgesByKey.set(key, (mountedHostBridgesByKey.get(key) ?? 0) + 1)
    return () => {
      const remaining = (mountedHostBridgesByKey.get(key) ?? 1) - 1
      if (remaining <= 0) {
        mountedHostBridgesByKey.delete(key)
        activeInPageHostKeys.delete(key)
        setViewingWorkspace(null)
      } else {
        mountedHostBridgesByKey.set(key, remaining)
      }
    }
  }, [handlesHostNavigation, hostId, setViewingWorkspace])
  useEffect(() => {
    if (!enabled) {
      return
    }
    return registerInPageNotificationNavigation(hostId, (target) => {
      if (isFocused && !isFocused()) {
        return false
      }
      if (
        pageRouteWorkspace(route.pathname) === null &&
        !ownsHostArea &&
        !activeInPageHostKeys.has(normalizeHostKey(hostId))
      ) {
        return false
      }
      const encoded = encodeInPageNotificationTarget(target)
      publishRoute({
        pathname: route.pathname,
        params: {
          ...route.params,
          paneKey: encoded
        }
      })
      return true
    })
  }, [enabled, hostId, isFocused, ownsHostArea, publishRoute, route])
}
