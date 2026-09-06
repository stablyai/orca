import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import ExpoMobileWebShell, { type MobileWebShellSession } from '@orca/expo-mobile-web-shell'
import type { HostProfile } from '../transport/types'
import { mobileWebDiagnosticsStore } from './mobile-web-diagnostics-store'
import { removeMobileWebHostCache } from './mobile-web-native-stager'
import type { MobileWebProcessFailureTracker } from './mobile-web-process-failure-tracker'
import { mobileWebShellHostName, type MobileWebShellNotice } from './mobile-web-shell-notice'

type PackageRecoveryState = {
  host: HostProfile | undefined
  hostEpochRef: RefObject<number>
  sessionGenerationRef: RefObject<number>
  activeHostIdRef: RefObject<string | null>
  ownedSessionRef: RefObject<MobileWebShellSession | null>
  processFailuresRef: RefObject<MobileWebProcessFailureTracker>
  rejectedBuildIdsRef: RefObject<Set<string>>
  setSession: Dispatch<SetStateAction<MobileWebShellSession | null>>
  setSessionHostId: Dispatch<SetStateAction<string | undefined>>
  setViewEpoch: Dispatch<SetStateAction<number>>
  setPackageLoading: Dispatch<SetStateAction<boolean>>
  setPackageWarning: Dispatch<SetStateAction<MobileWebShellNotice | undefined>>
  setRefreshEpoch: Dispatch<SetStateAction<number>>
}

export type MobileWebPackageRecoveryActions = {
  markHealthy: (sessionId: string) => Promise<void>
  handleHealthTimeout: (sessionId: string) => Promise<void>
  handleProcessTerminated: (sessionId: string) => Promise<void>
  retryPackage: () => void
  recoverPrevious: () => Promise<void>
  clearCache: () => Promise<void>
}

export function useMobileWebPackageRecovery({
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
}: PackageRecoveryState): MobileWebPackageRecoveryActions {
  const recoverSession = useCallback(
    async (
      sessionId: string,
      warning: MobileWebShellNotice,
      failureCode: string,
      { restartViewOnFailure }: { restartViewOnFailure: boolean }
    ) => {
      const current = ownedSessionRef.current
      const hostEpoch = hostEpochRef.current
      const hostId = activeHostIdRef.current
      if (!current || !hostId || current.sessionId !== sessionId) {
        return
      }
      rejectedBuildIdsRef.current.add(current.buildId)
      try {
        const recovered = await ExpoMobileWebShell.recoverSession(sessionId)
        if (
          hostEpochRef.current !== hostEpoch ||
          ownedSessionRef.current?.sessionId !== sessionId
        ) {
          await ExpoMobileWebShell.closeSession(recovered.sessionId).catch(() => {})
          return
        }
        ownedSessionRef.current = recovered
        sessionGenerationRef.current += 1
        setSession(recovered)
        setSessionHostId(hostId)
        setViewEpoch(0)
        setPackageWarning(warning)
        mobileWebDiagnosticsStore.recovered(hostId, recovered.buildId, failureCode)
      } catch {
        if (
          hostEpochRef.current !== hostEpoch ||
          ownedSessionRef.current?.sessionId !== sessionId
        ) {
          return
        }
        if (!restartViewOnFailure) {
          // Restarting the view restarts the deadline that just expired, so a page that simply
          // needs longer than one deadline can never converge — it reloads forever.
          setPackageWarning({
            message:
              'Orca is taking longer than usual to start. There’s no earlier version to go back to.',
            code: 'no_previous_version'
          })
          mobileWebDiagnosticsStore.warning(hostId, failureCode)
          return
        }
        setViewEpoch((value) => value + 1)
        setPackageWarning({
          message: 'Orca restarted. There’s no earlier version to go back to.',
          code: 'no_previous_version'
        })
        mobileWebDiagnosticsStore.restarted(hostId, current.buildId)
      }
    },
    [
      activeHostIdRef,
      hostEpochRef,
      ownedSessionRef,
      sessionGenerationRef,
      rejectedBuildIdsRef,
      setPackageWarning,
      setSession,
      setSessionHostId,
      setViewEpoch
    ]
  )

  const markHealthy = useCallback(
    async (sessionId: string) => {
      const owned = ownedSessionRef.current
      const sessionGeneration = sessionGenerationRef.current
      if (!owned || owned.sessionId !== sessionId) {
        return
      }
      try {
        await ExpoMobileWebShell.markSessionHealthy(sessionId)
        const current = ownedSessionRef.current
        if (
          sessionGenerationRef.current === sessionGeneration &&
          current?.sessionId === sessionId &&
          current.buildId === owned.buildId
        ) {
          const hostId = activeHostIdRef.current
          if (hostId) {
            mobileWebDiagnosticsStore.healthy(hostId, current.buildId)
          }
        }
      } catch {
        const current = ownedSessionRef.current
        if (
          sessionGenerationRef.current === sessionGeneration &&
          current?.sessionId === sessionId &&
          current.buildId === owned.buildId
        ) {
          setPackageWarning({
            message: 'Orca started, but couldn’t finish its checks.',
            code: 'health_mark_failed'
          })
          const hostId = activeHostIdRef.current
          if (hostId) {
            mobileWebDiagnosticsStore.warning(hostId, 'health_mark_failed')
          }
        }
      }
    },
    [activeHostIdRef, ownedSessionRef, sessionGenerationRef, setPackageWarning]
  )

  const handleHealthTimeout = useCallback(
    async (sessionId: string) => {
      await recoverSession(
        sessionId,
        { message: 'The update didn’t start correctly, so the last version that worked is back.' },
        'health_timeout',
        { restartViewOnFailure: false }
      )
    },
    [recoverSession]
  )

  const handleProcessTerminated = useCallback(
    async (sessionId: string) => {
      const current = ownedSessionRef.current
      if (!current || current.sessionId !== sessionId) {
        return
      }
      if (!processFailuresRef.current.record(current.buildId)) {
        setViewEpoch((value) => value + 1)
        setPackageWarning({ message: 'Orca stopped unexpectedly and restarted.' })
        const hostId = activeHostIdRef.current
        if (hostId) {
          mobileWebDiagnosticsStore.restarted(hostId, current.buildId)
        }
        return
      }
      await recoverSession(
        sessionId,
        { message: 'Orca kept stopping, so the last version that worked is back.' },
        'webview_crash_loop',
        { restartViewOnFailure: true }
      )
    },
    [
      activeHostIdRef,
      ownedSessionRef,
      processFailuresRef,
      recoverSession,
      setPackageWarning,
      setViewEpoch
    ]
  )

  const retryPackage = useCallback(() => {
    if (!activeHostIdRef.current) {
      return
    }
    setPackageLoading(true)
    setPackageWarning(undefined)
    setRefreshEpoch((value) => value + 1)
  }, [activeHostIdRef, setPackageLoading, setPackageWarning, setRefreshEpoch])

  const recoverPrevious = useCallback(async () => {
    const current = ownedSessionRef.current
    if (!current) {
      setPackageWarning({
        message: 'There’s no earlier version to go back to.',
        code: 'no_previous_version'
      })
      return
    }
    await recoverSession(
      current.sessionId,
      { message: 'Went back to the last version that worked.' },
      'manual_recovery',
      { restartViewOnFailure: true }
    )
  }, [ownedSessionRef, recoverSession, setPackageWarning])

  const clearCache = useCallback(async () => {
    // Invalidate refresh/open continuations before any await so a clear cannot race a
    // download that publishes a session into the cache being removed.
    const hostEpoch = hostEpochRef.current + 1
    hostEpochRef.current = hostEpoch
    const current = ownedSessionRef.current
    if (!host || !activeHostIdRef.current) {
      return
    }
    ownedSessionRef.current = null
    sessionGenerationRef.current += 1
    setSession(null)
    setSessionHostId(undefined)
    setViewEpoch(0)
    setPackageLoading(true)
    setPackageWarning(undefined)
    if (current) {
      await ExpoMobileWebShell.closeSession(current.sessionId).catch(() => {})
    }
    try {
      await removeMobileWebHostCache(host.publicKeyB64)
    } catch {
      if (hostEpochRef.current === hostEpoch) {
        setPackageLoading(false)
        setPackageWarning({
          message: `Couldn’t reset ${mobileWebShellHostName(host.name)}. Try again.`,
          code: 'reset_failed'
        })
      }
      return
    }
    if (hostEpochRef.current === hostEpoch) {
      processFailuresRef.current.reset()
      rejectedBuildIdsRef.current.clear()
      setRefreshEpoch((value) => value + 1)
    }
  }, [
    activeHostIdRef,
    host,
    hostEpochRef,
    ownedSessionRef,
    processFailuresRef,
    rejectedBuildIdsRef,
    setPackageLoading,
    setPackageWarning,
    setRefreshEpoch,
    setSession,
    setSessionHostId,
    setViewEpoch
  ])

  return {
    markHealthy,
    handleHealthTimeout,
    handleProcessTerminated,
    retryPackage,
    recoverPrevious,
    clearCache
  }
}
