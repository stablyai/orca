import { useCallback, useEffect, useRef, useState } from 'react'
import type { MobileWebResumeRoute } from '../../../src/shared/mobile-web/bridge-contract'
import type { HostProfile } from '../transport/types'
import type { MobileWebHostResumeRoute } from './mobile-web-capability-broker-options'
import {
  clearMobileWebColdResumeRoute,
  clearMobileWebColdResumeRouteForHost,
  loadMobileWebColdResumeRoute,
  saveMobileWebColdResumeRoute,
  type MobileWebColdResumeRoute
} from './mobile-web-cold-resume-route'
import {
  MOBILE_WEB_NAVIGATION_INTENTS,
  type MobileWebNavigationIntent
} from './mobile-web-navigation-intent-buffer'

export type MobileWebColdResumeRouteBinding = {
  rememberHostRoute: (route: MobileWebHostResumeRoute) => void
  clearRoute: () => void
  onNavigationResolved: (intent: MobileWebNavigationIntent, route: MobileWebResumeRoute) => void
}

export function useMobileWebColdResumeRoute(options: {
  hosts: readonly HostProfile[]
  hostsLoading: boolean
  hostsLoadFailed: boolean
  explicitHostId: string | undefined
  selectedHostId: string | undefined
  shellSessionId: string | undefined
  selectHost: (hostId: string | undefined) => void
}): MobileWebColdResumeRouteBinding {
  const [route, setRoute] = useState<MobileWebColdResumeRoute | null>(null)
  const restoredSessionKeyRef = useRef<string | undefined>(undefined)
  const pendingRestorationSessionRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    void loadMobileWebColdResumeRoute().then((stored) => {
      if (!cancelled) {
        setRoute(stored)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!route || options.explicitHostId || options.hostsLoading || options.hostsLoadFailed) {
      return
    }
    if (!options.hosts.some((host) => host.id === route.hostIdentity)) {
      setRoute(null)
      void clearMobileWebColdResumeRouteForHost(route.hostIdentity).catch(() => {})
      return
    }
    if (options.selectedHostId !== route.hostIdentity) {
      options.selectHost(route.hostIdentity)
    }
  }, [
    options.explicitHostId,
    options.hosts,
    options.hostsLoadFailed,
    options.hostsLoading,
    options.selectHost,
    options.selectedHostId,
    route
  ])

  useEffect(() => {
    if (!route || !options.shellSessionId || options.selectedHostId !== route.hostIdentity) {
      return
    }
    const restorationKey = `${options.shellSessionId}:${route.hostWorkspaceIdentity}`
    if (restoredSessionKeyRef.current === restorationKey) {
      return
    }
    restoredSessionKeyRef.current = restorationKey
    pendingRestorationSessionRef.current = options.shellSessionId
    MOBILE_WEB_NAVIGATION_INTENTS.publish(
      {
        kind: 'session',
        hostId: route.hostIdentity,
        hostWorkspaceId: route.hostWorkspaceIdentity
      },
      'coldResume'
    )
  }, [options.selectedHostId, options.shellSessionId, route])

  const rememberHostRoute = useCallback(
    (next: MobileWebHostResumeRoute) => {
      if (next.kind === 'workspaceList') {
        if (pendingRestorationSessionRef.current === options.shellSessionId) {
          return
        }
        restoredSessionKeyRef.current = undefined
        setRoute(null)
        void clearMobileWebColdResumeRoute().catch(() => {})
        return
      }
      if (!options.selectedHostId) {
        return
      }
      pendingRestorationSessionRef.current = undefined
      const stored = {
        hostIdentity: options.selectedHostId,
        hostWorkspaceIdentity: next.hostWorkspaceId
      }
      restoredSessionKeyRef.current = options.shellSessionId
        ? `${options.shellSessionId}:${next.hostWorkspaceId}`
        : undefined
      setRoute(stored)
      void saveMobileWebColdResumeRoute(stored).catch(() => {})
    },
    [options.selectedHostId, options.shellSessionId]
  )
  const onNavigationResolved = useCallback(
    (intent: MobileWebNavigationIntent, resolved: MobileWebResumeRoute) => {
      if (intent.source !== 'coldResume') {
        return
      }
      pendingRestorationSessionRef.current = undefined
      if (resolved.kind === 'workspaceList') {
        restoredSessionKeyRef.current = undefined
        setRoute(null)
        void clearMobileWebColdResumeRoute().catch(() => {})
      }
    },
    []
  )
  const clearRoute = useCallback(() => {
    pendingRestorationSessionRef.current = undefined
    restoredSessionKeyRef.current = undefined
    setRoute(null)
    void clearMobileWebColdResumeRoute().catch(() => {})
  }, [])
  return { rememberHostRoute, clearRoute, onNavigationResolved }
}
