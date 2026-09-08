import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import ExpoMobileWebShell, { type MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import { MOBILE_WEB_BRIDGE_PROTOCOL_VERSION } from '../../../src/shared/mobile-web/bridge-contract'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, HostProfile } from '../transport/types'
import { startMobileWebPackageCapabilityProbe } from './mobile-web-package-capability-probe'
import { mobileWebDiagnosticsStore } from './mobile-web-diagnostics-store'
import { removeMobileWebHostCache } from './mobile-web-native-stager'
import {
  mobileWebPackageRefreshDelayMs,
  waitBeforeMobileWebPackageRefresh
} from './mobile-web-package-refresh-backoff'
import { runMobileWebPackageRefresh } from './mobile-web-package-refresh'
import {
  currentConnectionId,
  initialMobileWebPackageState,
  mobileWebPackageCapability,
  mobileWebPackageReducer,
  type MobileWebPackageSession
} from './mobile-web-package-session-state'
import { mobileWebShellHostName } from './mobile-web-shell-notice'

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
  const [packageState, dispatch] = useReducer(mobileWebPackageReducer, initialMobileWebPackageState)
  const hostEpochRef = useRef(0)
  const ownedSessionRef = useRef<MobileWebShellSession | null>(null)
  const cachedBuildRef = useRef<Promise<string | null>>(Promise.resolve(null))
  // One re-download per build: a desktop upgrade gets its own recovery attempt.
  const droppedGenerationRef = useRef<string | null>(null)
  const droppedHostRef = useRef<string | undefined>(undefined)
  const retryRef = useRef({ hostId: '', loadEpoch: -1, attempts: 0 })
  const connectionId = currentConnectionId(client)
  const resolved = mobileWebPackageCapability(packageState, {
    client,
    hostId: host?.id,
    connected: state === 'connected'
  })
  // A fresh object every render would restart the refresh effect on every render.
  const capability = useMemo(() => resolved, [resolved.gzip, resolved.range, resolved.status])
  const packageAccessAllowed =
    capability.status === 'offline' ||
    capability.status === 'supported' ||
    (capability.status === 'pending' && ownedSessionRef.current !== null)
  const { loadEpoch } = packageState

  const publishSession = useCallback(
    async (
      next: MobileWebShellSession,
      isCurrent: () => boolean,
      hostId: string,
      source: 'verified-cache' | 'desktop-refresh',
      activationStartedAt: number
    ): Promise<boolean> => {
      if (!isCurrent()) {
        await ExpoMobileWebShell.closeSession(next.sessionId).catch(() => {})
        return false
      }
      const previous = ownedSessionRef.current
      if (previous && previous.sessionId !== next.sessionId) {
        await beforeSessionReplacement?.()
        if (!isCurrent()) {
          await ExpoMobileWebShell.closeSession(next.sessionId).catch(() => {})
          return false
        }
      }
      ownedSessionRef.current = next
      dispatch({ type: 'session-published', session: next, hostId })
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
    if (state !== 'connected' || !client || !host) {
      return
    }
    return startMobileWebPackageCapabilityProbe(client, host.id, connectionId, (capability) =>
      dispatch({ type: 'capability-resolved', capability })
    )
  }, [client, connectionId, host?.id, state])

  useEffect(() => {
    const hostEpoch = ++hostEpochRef.current
    if (droppedHostRef.current !== host?.id) {
      droppedHostRef.current = host?.id
      droppedGenerationRef.current = null
    }
    dispatch({ type: 'reopening', hasHost: Boolean(host) })
    const closing = ownedSessionRef.current
    ownedSessionRef.current = null
    if (closing) {
      void ExpoMobileWebShell.closeSession(closing.sessionId).catch(() => {})
    }
    if (!host) {
      cachedBuildRef.current = Promise.resolve(null)
      return
    }
    mobileWebDiagnosticsStore.begin(host.id)
    if (!packageAccessAllowed) {
      cachedBuildRef.current = Promise.resolve(null)
      if (capability.status === 'update-required') {
        mobileWebDiagnosticsStore.warning(host.id, 'host_update_required')
        dispatch({
          type: 'download-settled',
          warning: {
            message: `Update Orca on ${mobileWebShellHostName(host.name)} to continue.`,
            code: 'host_update_required'
          }
        })
      }
      return
    }
    let disposed = false
    const startedAt = Date.now()
    cachedBuildRef.current = ExpoMobileWebShell.openSession(
      host.publicKeyB64,
      null,
      MOBILE_WEB_BRIDGE_PROTOCOL_VERSION
    )
      .then(async (cached) => {
        if (disposed || ownedSessionRef.current) {
          await ExpoMobileWebShell.closeSession(cached.sessionId).catch(() => {})
          return null
        }
        const published = await publishSession(
          cached,
          () => hostEpochRef.current === hostEpoch && !disposed,
          host.id,
          'verified-cache',
          startedAt
        )
        return published ? cached.buildId : null
      })
      .catch(() => {
        if (!disposed && hostEpochRef.current === hostEpoch && !ownedSessionRef.current) {
          mobileWebDiagnosticsStore.warning(host.id, 'cache_open_failed')
        }
        return null
      })
    return () => {
      disposed = true
      if (hostEpochRef.current !== hostEpoch) {
        return
      }
      hostEpochRef.current += 1
      const owned = ownedSessionRef.current
      ownedSessionRef.current = null
      if (owned) {
        void ExpoMobileWebShell.closeSession(owned.sessionId).catch(() => {})
      }
    }
  }, [host?.id, host?.publicKeyB64, loadEpoch, packageAccessAllowed, publishSession])

  useEffect(() => {
    if (!host) {
      return
    }
    const hostEpoch = hostEpochRef.current
    const cachedBuild = cachedBuildRef.current
    const controller = new AbortController()
    const isCurrent = (): boolean =>
      !controller.signal.aborted && hostEpochRef.current === hostEpoch
    if (state !== 'connected') {
      void cachedBuild.then(() => {
        if (isCurrent()) {
          dispatch({ type: 'download-settled' })
        }
      })
      return () => controller.abort()
    }
    if (!client || capability.status !== 'supported') {
      return
    }
    // A host change or a dropped generation both start the backoff ladder over.
    if (retryRef.current.hostId !== host.id || retryRef.current.loadEpoch !== loadEpoch) {
      retryRef.current = { hostId: host.id, loadEpoch, attempts: 0 }
    }
    const retryDelayMs = mobileWebPackageRefreshDelayMs(retryRef.current.attempts)
    retryRef.current.attempts += 1
    dispatch({ type: 'download-started' })
    void (async () => {
      if (!(await waitBeforeMobileWebPackageRefresh(retryDelayMs, controller.signal))) {
        return
      }
      const outcome = await runMobileWebPackageRefresh({
        client,
        host,
        capability,
        signal: controller.signal,
        isCurrent,
        hasSession: () => Boolean(ownedSessionRef.current),
        onProgress: (progress) => dispatch({ type: 'download-progress', progress }),
        // The bundle is on disk: what happens next costs no download, so the ladder resets.
        onDownloaded: () => {
          retryRef.current.attempts = 0
        },
        publish: (session, startedAt) =>
          publishSession(session, isCurrent, host.id, 'desktop-refresh', startedAt),
        isVerifiedBuild: async (buildId) => {
          // An owned session only ever comes from openSession, so its build is already verified;
          // otherwise wait for the cache probe rather than re-downloading what is on disk.
          if (isCurrent() && ownedSessionRef.current?.buildId === buildId) {
            return true
          }
          return (
            (await cachedBuild) === buildId &&
            isCurrent() &&
            ownedSessionRef.current?.buildId === buildId
          )
        }
      })
      if (outcome.kind === 'settled') {
        dispatch({ type: 'download-settled' })
      } else if (outcome.kind === 'failed') {
        dispatch({ type: 'download-settled', warning: outcome.warning })
      }
    })()
    return () => controller.abort()
  }, [capability, client, host?.id, host?.publicKeyB64, loadEpoch, publishSession, state])

  const showWarning = useCallback(
    (message: string, code?: string) => dispatch({ type: 'warning', warning: { message, code } }),
    []
  )

  const handleLoadFailure = useCallback(
    (reason: string | undefined) => {
      const owned = ownedSessionRef.current
      const hostId = host?.id
      if (!host || !hostId) {
        return
      }
      mobileWebDiagnosticsStore.warning(hostId, reason ?? 'mobile_web_document_unavailable')
      if (!owned || droppedGenerationRef.current === owned.buildId) {
        dispatch({
          type: 'warning',
          warning: { message: 'Couldn’t open Orca.', code: reason }
        })
        return
      }
      // The cached generation cannot render, so it is deleted and downloaded again; an unreachable
      // desktop leaves the shell in its offline state until the connection returns.
      droppedGenerationRef.current = owned.buildId
      const dropEpoch = ++hostEpochRef.current
      ownedSessionRef.current = null
      dispatch({
        type: 'generation-dropping',
        warning: { message: 'Couldn’t open Orca. Getting it again…', code: reason }
      })
      void (async () => {
        await ExpoMobileWebShell.closeSession(owned.sessionId).catch(() => {})
        await removeMobileWebHostCache(host.publicKeyB64).catch(() => {})
        if (hostEpochRef.current === dropEpoch) {
          dispatch({ type: 'reload' })
        }
      })()
    },
    [host?.id, host?.publicKeyB64, host?.name]
  )

  const handleProcessTerminated = useCallback(
    (sessionId: string) => {
      const owned = ownedSessionRef.current
      if (!owned || owned.sessionId !== sessionId) {
        return
      }
      if (host) {
        mobileWebDiagnosticsStore.restarted(host.id, owned.buildId)
      }
      dispatch({
        type: 'view-restarted',
        warning: { message: 'Orca stopped unexpectedly and restarted.' }
      })
    },
    [host?.id]
  )

  return useMemo(
    () => ({
      session: packageState.session,
      sessionHostId: packageState.sessionHostId,
      viewEpoch: packageState.viewEpoch,
      packageLoading: capability.status === 'update-required' ? false : packageState.loading,
      packageProgress: packageState.progress,
      packageWarning: packageState.warning,
      handleLoadFailure,
      handleProcessTerminated,
      showWarning
    }),
    [capability.status, handleLoadFailure, handleProcessTerminated, packageState, showWarning]
  )
}
