import { useCallback, useEffect, useRef, useState } from 'react'
import ExpoMobileWebShell, { type MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import { MobileWebProcessFailureTracker } from './mobile-web-process-failure-tracker'
import type { MobileWebPackageDownloadProgress } from './mobile-web-package-downloader'
import { mobileWebDiagnosticsStore } from './mobile-web-diagnostics-store'
import {
  createMobileWebCachedBuildProbe,
  type MobileWebCachedBuildProbe
} from './mobile-web-cached-build-probe'
import { useMobileWebPackageCapability } from './use-mobile-web-package-capability'
import { useMobileWebPackageRecovery } from './use-mobile-web-package-recovery'
import { useMobileWebPackageRefresh } from './use-mobile-web-package-refresh'
import type { MobileWebPackageSession } from './mobile-web-package-session-state'
import { mobileWebShellHostName, type MobileWebShellNotice } from './mobile-web-shell-notice'

export type { MobileWebPackageSession } from './mobile-web-package-session-state'
export function useMobileWebPackageSession({
  client,
  host,
  state,
  beforeSessionReplacement
}: {
  client: RpcClient | null
  host: HostProfile | undefined
  state: ConnectionState
  beforeSessionReplacement?: () => Promise<void>
}): MobileWebPackageSession {
  const hostEpochRef = useRef(0)
  const sessionGenerationRef = useRef(0)
  const activeHostIdRef = useRef<string | null>(null)
  const ownedSessionRef = useRef<MobileWebShellSession | null>(null)
  const cachedBuildProbeRef = useRef<MobileWebCachedBuildProbe | null>(null)
  const refreshingHostEpochRef = useRef<number | null>(null)
  const processFailuresRef = useRef(new MobileWebProcessFailureTracker())
  const rejectedBuildIdsRef = useRef(new Set<string>())
  const [session, setSession] = useState<MobileWebShellSession | null>(null)
  const [sessionHostId, setSessionHostId] = useState<string>()
  const [viewEpoch, setViewEpoch] = useState(0)
  const [packageLoading, setPackageLoading] = useState(false)
  const [packageProgress, setPackageProgress] = useState<MobileWebPackageDownloadProgress>()
  const [packageWarning, setPackageWarning] = useState<MobileWebShellNotice>()
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const packageCapability = useMobileWebPackageCapability({
    client,
    hostId: host?.id,
    state
  })
  const packageAccessAllowed =
    packageCapability.status === 'offline' ||
    packageCapability.status === 'supported' ||
    (packageCapability.status === 'pending' && ownedSessionRef.current !== null)
  const effectivePackageLoading =
    packageCapability.status === 'update-required' ? false : packageLoading
  const effectivePackageWarning =
    packageWarning ??
    (packageCapability.status === 'update-required'
      ? {
          message: `Update Orca on ${mobileWebShellHostName(host?.name)} to continue.`,
          code: 'host_update_required'
        }
      : undefined)

  const publishSession = useCallback(
    async (
      next: MobileWebShellSession,
      hostEpoch: number,
      hostId: string,
      source: 'verified-cache' | 'desktop-refresh',
      activationStartedAt: number
    ): Promise<boolean> => {
      if (hostEpochRef.current !== hostEpoch) {
        await ExpoMobileWebShell.closeSession(next.sessionId).catch(() => {})
        return false
      }
      const previous = ownedSessionRef.current
      if (previous && previous.sessionId !== next.sessionId) {
        await beforeSessionReplacement?.()
        if (hostEpochRef.current !== hostEpoch) {
          await ExpoMobileWebShell.closeSession(next.sessionId).catch(() => {})
          return false
        }
      }
      ownedSessionRef.current = next
      sessionGenerationRef.current += 1
      setSession(next)
      setSessionHostId(hostId)
      setViewEpoch(0)
      setPackageLoading(false)
      setPackageProgress(undefined)
      mobileWebDiagnosticsStore.sessionReady(
        hostId,
        next.buildId,
        source,
        Date.now() - activationStartedAt
      )
      if (previous && previous.sessionId !== next.sessionId) {
        await ExpoMobileWebShell.closeSession(previous.sessionId).catch(() => {})
      }
      return true
    },
    [beforeSessionReplacement]
  )

  useEffect(() => {
    const hostEpoch = hostEpochRef.current + 1
    hostEpochRef.current = hostEpoch
    sessionGenerationRef.current += 1
    cachedBuildProbeRef.current?.resolve(null)
    const cachedBuildProbe = createMobileWebCachedBuildProbe(hostEpoch)
    cachedBuildProbeRef.current = cachedBuildProbe
    activeHostIdRef.current = host?.id ?? null
    refreshingHostEpochRef.current = null
    processFailuresRef.current.reset()
    rejectedBuildIdsRef.current.clear()
    const previous = ownedSessionRef.current
    ownedSessionRef.current = null
    setSession(null)
    setSessionHostId(undefined)
    setViewEpoch(0)
    setPackageWarning(undefined)
    setPackageLoading(Boolean(host))
    setPackageProgress(undefined)
    if (previous) {
      void ExpoMobileWebShell.closeSession(previous.sessionId).catch(() => {})
    }
    if (!host) {
      cachedBuildProbe.resolve(null)
      return
    }
    mobileWebDiagnosticsStore.begin(host.id)
    if (!packageAccessAllowed) {
      cachedBuildProbe.resolve(null)
      return
    }
    let disposed = false
    const cacheActivationStartedAt = Date.now()
    void ExpoMobileWebShell.openSession(host.publicKeyB64, null, MOBILE_WEB_BRIDGE_PROTOCOL_VERSION)
      .then(async (cached) => {
        const published = await (!disposed && !ownedSessionRef.current
          ? publishSession(cached, hostEpoch, host.id, 'verified-cache', cacheActivationStartedAt)
          : ExpoMobileWebShell.closeSession(cached.sessionId)
              .catch(() => {})
              .then(() => false))
        cachedBuildProbe.resolve(published ? cached.buildId : null)
      })
      .catch(() => {
        cachedBuildProbe.resolve(null)
        if (!disposed && hostEpochRef.current === hostEpoch && !ownedSessionRef.current) {
          mobileWebDiagnosticsStore.warning(host.id, 'cache_open_failed')
          if (refreshingHostEpochRef.current !== hostEpoch) {
            setPackageLoading(false)
            setPackageWarning(
              (current) =>
                current ?? {
                  message: `Connect to ${mobileWebShellHostName(host.name)} to finish setting up.`
                }
            )
          }
        }
      })
    return () => {
      disposed = true
      cachedBuildProbe.resolve(null)
      if (hostEpochRef.current !== hostEpoch) {
        return
      }
      hostEpochRef.current += 1
      sessionGenerationRef.current += 1
      activeHostIdRef.current = null
      const closing = ownedSessionRef.current
      ownedSessionRef.current = null
      if (closing) {
        void ExpoMobileWebShell.closeSession(closing.sessionId).catch(() => {})
      }
    }
  }, [host?.id, host?.publicKeyB64, packageAccessAllowed, publishSession])

  useEffect(() => {
    if (!host || packageAccessAllowed) {
      return
    }
    if (packageCapability.status === 'update-required') {
      mobileWebDiagnosticsStore.warning(host.id, 'host_update_required')
    }
  }, [host?.id, packageAccessAllowed, packageCapability])

  useMobileWebPackageRefresh({
    client,
    host,
    state,
    packageCapability,
    cachedBuildProbeRef,
    hostEpochRef,
    ownedSessionRef,
    rejectedBuildIdsRef,
    refreshingHostEpochRef,
    publishSession,
    refreshEpoch,
    setPackageLoading,
    setPackageWarning,
    setPackageProgress
  })

  const showWarning = useCallback(
    (message: string, code?: string) => setPackageWarning({ message, code }),
    []
  )

  const {
    markHealthy,
    handleHealthTimeout,
    handleProcessTerminated,
    retryPackage,
    recoverPrevious,
    clearCache
  } = useMobileWebPackageRecovery({
    host,
    hostEpochRef,
    sessionGenerationRef,
    activeHostIdRef,
    ownedSessionRef,
    processFailuresRef,
    rejectedBuildIdsRef,
    setSession,
    setSessionHostId,
    setViewEpoch,
    setPackageLoading,
    setPackageWarning,
    setRefreshEpoch
  })

  return {
    session,
    sessionHostId,
    viewEpoch,
    packageLoading: effectivePackageLoading,
    packageProgress,
    packageWarning: effectivePackageWarning,
    markHealthy,
    handleHealthTimeout,
    handleProcessTerminated,
    retryPackage,
    recoverPrevious,
    clearCache,
    showWarning
  }
}
