import { useEffect, useRef, type MutableRefObject } from 'react'
import ExpoMobileWebShell, { type MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import { MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES } from '../../../src/shared/mobile-web/package-rpc-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import { createMobileWebNativeStager } from './mobile-web-native-stager'
import {
  downloadMobileWebPackage,
  mobileWebPackageDownloadFailureCode,
  type MobileWebPackageDownloadProgress
} from './mobile-web-package-downloader'
import { mobileWebDiagnosticsStore } from './mobile-web-diagnostics-store'
import {
  mobileWebPackageRefreshDelayMs,
  waitBeforeMobileWebPackageRefresh
} from './mobile-web-package-refresh-backoff'
import type { MobileWebCachedBuildProbe } from './mobile-web-cached-build-probe'
import { mobileWebPackageRefreshWarning } from './mobile-web-package-refresh-warning'
import type { MobileWebShellNotice } from './mobile-web-shell-notice'
import type { MobileWebPackageCapability } from './use-mobile-web-package-capability'

type PublishSession = (
  next: MobileWebShellSession,
  hostEpoch: number,
  hostId: string,
  source: 'verified-cache' | 'desktop-refresh',
  activationStartedAt: number
) => Promise<boolean>

export function useMobileWebPackageRefresh(args: {
  client: RpcClient | null
  host: HostProfile | undefined
  state: ConnectionState
  packageCapability: MobileWebPackageCapability
  cachedBuildProbeRef: MutableRefObject<MobileWebCachedBuildProbe | null>
  hostEpochRef: MutableRefObject<number>
  ownedSessionRef: MutableRefObject<MobileWebShellSession | null>
  rejectedBuildIdsRef: MutableRefObject<Set<string>>
  refreshingHostEpochRef: MutableRefObject<number | null>
  publishSession: PublishSession
  refreshEpoch: number
  setPackageLoading: (loading: boolean) => void
  setPackageWarning: (warning: MobileWebShellNotice | undefined) => void
  setPackageProgress: (progress: MobileWebPackageDownloadProgress | undefined) => void
}) {
  const {
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
  } = args
  const retryRef = useRef({ hostId: '', refreshEpoch, attempts: 0 })

  useEffect(() => {
    if (!host || !client || state !== 'connected' || packageCapability.status !== 'supported') {
      return
    }
    const hostEpoch = hostEpochRef.current
    const cachedBuildProbe = cachedBuildProbeRef.current
    const controller = new AbortController()
    // A user-driven retry and a host change both start the backoff ladder over.
    if (retryRef.current.hostId !== host.id || retryRef.current.refreshEpoch !== refreshEpoch) {
      retryRef.current = { hostId: host.id, refreshEpoch, attempts: 0 }
    }
    const retryDelayMs = mobileWebPackageRefreshDelayMs(retryRef.current.attempts)
    retryRef.current.attempts += 1
    refreshingHostEpochRef.current = hostEpoch
    setPackageLoading(true)
    setPackageWarning(undefined)
    setPackageProgress(undefined)
    void (async () => {
      if (!(await waitBeforeMobileWebPackageRefresh(retryDelayMs, controller.signal))) {
        return
      }
      const refreshStartedAt = Date.now()
      try {
        const downloaded = await downloadMobileWebPackage(
          (method, params) => client.sendRequest(method, params),
          createMobileWebNativeStager(host.publicKeyB64),
          {
            shellBridgeVersion: MOBILE_WEB_BRIDGE_PROTOCOL_VERSION,
            useGzip: packageCapability.gzip,
            ...(packageCapability.range ? { rangeBytes: MOBILE_WEB_PACKAGE_MAX_RANGE_BYTES } : {}),
            signal: controller.signal,
            onProgress: setPackageProgress,
            reuseVerifiedBuild: async (buildId) => {
              // An owned session only ever comes from openSession, so its build is already
              // verified; waiting on the cache probe here re-downloaded every build this host
              // epoch first learned from a refresh rather than from the cache.
              if (!controller.signal.aborted && ownedSessionRef.current?.buildId === buildId) {
                return true
              }
              const verifiedBuildId =
                cachedBuildProbe?.hostEpoch === hostEpoch ? await cachedBuildProbe.promise : null
              return (
                !controller.signal.aborted &&
                hostEpochRef.current === hostEpoch &&
                verifiedBuildId === buildId &&
                ownedSessionRef.current?.buildId === buildId
              )
            }
          }
        )
        // The bundle is staged: whatever happens next costs no more download, so the ladder resets.
        retryRef.current.attempts = 0
        if (controller.signal.aborted || hostEpochRef.current !== hostEpoch) {
          return
        }
        if (downloaded.reusedVerifiedBuild) {
          completeRefresh(host.id, refreshStartedAt)
          return
        }
        if (ownedSessionRef.current?.buildId === downloaded.commit.buildId) {
          completeRefresh(host.id, refreshStartedAt)
          return
        }
        if (rejectedBuildIdsRef.current.has(downloaded.commit.buildId)) {
          mobileWebDiagnosticsStore.warning(host.id, 'rejected_build')
          finishPackage(false, { message: 'Showing the last version that worked.' })
          return
        }
        const activationStartedAt = Date.now()
        const next = await ExpoMobileWebShell.openSession(
          host.publicKeyB64,
          downloaded.commit.buildId,
          MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
        )
        if (
          await publishSession(next, hostEpoch, host.id, 'desktop-refresh', activationStartedAt)
        ) {
          mobileWebDiagnosticsStore.refreshSucceeded(host.id, Date.now() - refreshStartedAt)
          setPackageWarning(undefined)
        }
      } catch (error) {
        if (!controller.signal.aborted && hostEpochRef.current === hostEpoch) {
          const failureCode = mobileWebPackageDownloadFailureCode(error)
          mobileWebDiagnosticsStore.warning(host.id, failureCode)
          console.warn('[mobile-web] package refresh failed', { code: failureCode })
          finishPackage(
            false,
            mobileWebPackageRefreshWarning(failureCode, Boolean(ownedSessionRef.current), host.name)
          )
        }
      }
    })().finally(() => {
      if (refreshingHostEpochRef.current === hostEpoch) {
        refreshingHostEpochRef.current = null
      }
    })
    return () => {
      controller.abort()
      if (refreshingHostEpochRef.current === hostEpoch) {
        refreshingHostEpochRef.current = null
      }
    }

    function completeRefresh(hostId: string, startedAt: number): void {
      mobileWebDiagnosticsStore.refreshSucceeded(hostId, Date.now() - startedAt)
      finishPackage(true)
    }

    function finishPackage(success: boolean, warning?: MobileWebShellNotice): void {
      setPackageLoading(false)
      setPackageProgress(undefined)
      if (success || warning) {
        setPackageWarning(warning)
      }
    }
  }, [client, host?.id, host?.publicKeyB64, packageCapability, publishSession, refreshEpoch, state])
}
