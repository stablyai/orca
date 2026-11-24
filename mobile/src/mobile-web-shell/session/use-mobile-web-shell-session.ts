import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useHostProtocolGates } from '../../components/host-connection/host-protocol-gates-context'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import { notePageVersion } from '../../transport/connection/mobile-page-client-capabilities'
import {
  createDownloadProgressFeed,
  downloadFraction,
  type DownloadProgressFeed
} from '../presentation/download-progress-feed'
import type { GenerationStore } from '../generations/generation-store'
import type { GenerationHold } from '../generations/generation-deferred-commits'
import { deriveHostCacheKey } from '../generations/host-cache-key'
import { runShellEffect, type FlowManifest } from './mobile-web-shell-session-effects'
import { documentMayTalk } from '../host-gates/mobile-web-shell-gates'
import { readMobileWebShellReachability } from '../host-gates/mobile-web-shell-reachability'
import { createMobileWebShellRuntime, type MobileWebShellRuntime } from './mobile-web-shell-runtime'
import { useMobileWebShellGates } from '../host-gates/use-mobile-web-shell-gates'
import { useResumeSwapConsent } from './use-resume-swap-consent'
import { askPagesAgain, latestAppResumeRound } from './app-resume-rounds'
import { shellPageBackClaimed } from '../page-document/shell-page-back-claim'
import { recordShellLifecycleLine } from '../diagnostics/shell-lifecycle-line-recorder'
import {
  EMPTY_SHELL_LOG_TRACE,
  SHELL_STALL_LOG_MS,
  shellSessionStepLines,
  shellStallLine,
  traceShellStep
} from '../diagnostics/shell-lifecycle-log'
import { shellPageFrame, type ShellPageFrame } from '../page-document/shell-page-frame'
import { createShellPageDeadline } from './shell-page-deadline'
import {
  evictRetainedShellSessionForHost,
  readRetainedShellSession,
  recordSessionInRetainedStore
} from './retained-shell-session-store'
import {
  createMobileWebShellSession,
  reduceMobileWebShellSession
} from './mobile-web-shell-session'
import { sessionFlowFloor } from './mobile-web-shell-session-step'
import type {
  MobileWebShellReportedFailure,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellSessionState,
  MobileWebShellUpdateNotice
} from './mobile-web-shell-session-contract'

export type MobileWebShellSessionView = {
  readonly state: MobileWebShellSessionState
  // Publish before React commit so progress can advance while the JS thread is busy.
  readonly downloadProgress: DownloadProgressFeed
  readonly pageRoutes: readonly string[]
  readonly pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[]
  readonly routeGrants: readonly string[]
  readonly ownsHostArea: boolean
  // Null until this connection's status opened the shown document's window; the bridge holds desktop-bound frames until then.
  readonly hostStatus: ReturnType<typeof useMobileWebShellGates>
  // Explain fallback beside the running page without replacing it.
  readonly updateNotice: MobileWebShellUpdateNotice | null
  readonly retry: () => void
  readonly reportShellFailure: (reason: MobileWebShellReportedFailure, reclaimed?: boolean) => void
  readonly reportDocumentStarted: () => void
  readonly reportDocumentLoaded: () => void
  readonly reportPageReady: () => void
  readonly reportPagePainted: () => void
  readonly reportPageBackClaim: (claimed: boolean) => void
  // The page's answer to a return from the background: whether it may reload onto a newer build now.
  readonly reportSwapSafe: (safe: boolean, round: number) => void
  // Project document facts into React state: page-ready alone changes no session-state identity to trigger a render.
  readonly pageReady: boolean
  // Project paint for the same reason: the ready state itself does not change.
  readonly pageFrame: ShellPageFrame
  // Project Back claims so claim-only events still rerender.
  readonly backClaimed: boolean
  readonly store: GenerationStore
}

// Run reducer effects behind an epoch fence so unmount/host change/retry cannot apply abandoned results to the replacement session.
export function useMobileWebShellSession(args: {
  hostId: string
  routePathname: string
  wide?: boolean
  appNamesRoute?: boolean
  runtime?: MobileWebShellRuntime
}): MobileWebShellSessionView {
  const { hostId, routePathname } = args
  const wide = args.wide === true
  const appNamesRoute = args.appNamesRoute !== false
  const gates = useHostProtocolGates()
  const { client, state: connState } = useHostClient(hostId)
  const { statusPending, statusReadable, hostCapabilities, hostProtocolWindow } = gates
  const reachability = readMobileWebShellReachability(connState, client)
  const sessionGates = {
    statusPending,
    statusReadable,
    reachability,
    hostCapabilities,
    hostStatus: hostProtocolWindow
  }

  const runtimeRef = useRef<MobileWebShellRuntime | null>(null)
  runtimeRef.current ??= args.runtime ?? createMobileWebShellRuntime()
  const runtime = runtimeRef.current
  const [store] = useState(() => runtime.createStore())

  const clientRef = useRef(client)
  clientRef.current = client
  const gatesRef = useRef(sessionGates)
  gatesRef.current = sessionGates

  const [sessionRef] = useState(() => ({
    current:
      readRetainedShellSession({
        hostId,
        routePathname,
        wide,
        appNamesRoute,
        client,
        gates: sessionGates
      }) ?? createMobileWebShellSession(routePathname, wide, appNamesRoute)
  }))
  const [state, setState] = useState(sessionRef.current.state)
  const [pageReady, setPageReady] = useState(sessionRef.current.pageReady)
  const [pageFrame, setPageFrame] = useState(() => shellPageFrame(sessionRef.current))
  const [backClaimed, setBackClaimed] = useState(() => shellPageBackClaimed(sessionRef.current))
  const [downloadProgress] = useState(createDownloadProgressFeed)
  const hostKey = useMemo(() => deriveHostCacheKey(hostId), [hostId])
  const startedAtRef = useRef(runtime.now())
  const epochRef = useRef(0)
  // Abort abandoned downloads to release their four host read slots.
  const downloadsRef = useRef<Set<AbortController>>(new Set())
  const [deadline] = useState(() => createShellPageDeadline(runtime.setForegroundTimer))
  const hostIdRef = useRef(hostId)
  // The flow's manifest reply, so its download reads windows without asking for the manifest again.
  const manifestRef = useRef<FlowManifest | null>(null)
  // Held while this shell shows a generation, so no update commits under it.
  const holdRef = useRef<GenerationHold | null>(null)
  const logTraceRef = useRef(EMPTY_SHELL_LOG_TRACE)
  const runEffectRef = useRef<
    ((epoch: number, flow: number, effect: MobileWebShellSessionEffect) => void) | null
  >(null)

  const cancelPending = useCallback((downloads = true): void => {
    if (downloads) {
      downloadsRef.current.forEach((controller) => controller.abort())
      downloadsRef.current.clear()
    }
    deadline.cancel()
  }, [deadline])

  const releaseHold = useCallback((): void => {
    holdRef.current?.release()
    holdRef.current = null
  }, [])

  const dispatch = useCallback(
    (epoch: number, event: MobileWebShellSessionEvent): void => {
      if (epoch !== epochRef.current) {
        return
      }
      const previous = sessionRef.current
      const stepped = reduceMobileWebShellSession(previous, event)
      const trace = traceShellStep(logTraceRef.current, previous, event, stepped.session)
      logTraceRef.current = trace
      for (const line of shellSessionStepLines(previous, event, stepped.session, trace)) {
        recordShellLifecycleLine(hostIdRef.current, line)
      }
      sessionRef.current = stepped.session
      recordSessionInRetainedStore(hostIdRef.current, clientRef.current, stepped.session)
      if (stepped.session.flow !== previous.flow) {
        cancelPending(sessionFlowFloor(stepped.session) !== sessionFlowFloor(previous))
      }
      const next = stepped.session.state
      // Take the hold before any effect runs, so another shell's open-cache cannot commit under this one.
      if (next.kind === 'ready' || next.kind === 'activating') {
        holdRef.current ??= store.holdGeneration(deriveHostCacheKey(hostIdRef.current), {
          swap: () => dispatch(epoch, { type: 'update-swap' }),
          askAgain: () => askPagesAgain(hostIdRef.current),
          latestRound: latestAppResumeRound
        })
      } else {
        releaseHold()
      }
      if (next.kind === 'ready') {
        // Before the document loads, so the host never sends this page what it can't draw.
        notePageVersion(hostIdRef.current, next.compat.pageVersion ?? 0)
      }
      if (next.kind === 'fetching') {
        downloadProgress.publish(downloadFraction(next.receivedBytes, next.totalBytes))
      }
      setState(next)
      setPageReady(stepped.session.pageReady)
      setPageFrame(shellPageFrame(stepped.session))
      setBackClaimed(shellPageBackClaimed(stepped.session))
      for (const effect of stepped.effects) {
        runEffectRef.current?.(epoch, stepped.session.flow, effect)
      }
    },
    [cancelPending, downloadProgress, releaseHold, store]
  )

  const invalidate = useCallback((): void => {
    epochRef.current += 1
    cancelPending()
    releaseHold()
    // A rebuilt session restarts flow numbers, so an old reply could otherwise match.
    manifestRef.current = null
  }, [cancelPending, releaseHold])

  const runEffect = useCallback(
    async (epoch: number, flow: number, effect: MobileWebShellSessionEffect): Promise<void> => {
      await runShellEffect(effect, {
        store,
        client,
        hostId,
        hostKey,
        runtime,
        flow,
        startedAt: startedAtRef.current,
        downloads: downloadsRef.current,
        deadline,
        manifest: manifestRef,
        send: (event) => dispatch(epoch, event)
      })
    },
    [client, deadline, dispatch, hostId, hostKey, runtime, store]
  )
  useEffect(() => {
    runEffectRef.current = (epoch, flow, effect) => void runEffect(epoch, flow, effect)
  }, [runEffect])

  const mountedIdentityRef = useRef({ hostId, routePathname, appNamesRoute, runtime })

  useLayoutEffect(
    () => () => {
      const current = sessionRef.current
      if (current.state.kind === 'ready' && current.pagePainted) {
        recordSessionInRetainedStore(hostIdRef.current, clientRef.current, current)
      }
    },
    [appNamesRoute, hostId, routePathname]
  )

  useEffect(() => {
    const prev = mountedIdentityRef.current
    if (
      prev.hostId === hostId &&
      prev.routePathname === routePathname &&
      prev.appNamesRoute === appNamesRoute &&
      prev.runtime === runtime
    ) {
      if (sessionRef.current.state.kind === 'ready' && sessionRef.current.pagePainted) {
        runEffectRef.current?.(epochRef.current, sessionRef.current.flow, { kind: 'read-manifest' })
      }
      return
    }
    mountedIdentityRef.current = { hostId, routePathname, appNamesRoute, runtime }
    invalidate()
    hostIdRef.current = hostId
    logTraceRef.current = EMPTY_SHELL_LOG_TRACE
    const retained = readRetainedShellSession({
      hostId,
      routePathname,
      wide,
      appNamesRoute,
      client: clientRef.current,
      gates: gatesRef.current
    })
    sessionRef.current = retained ?? createMobileWebShellSession(routePathname, wide, appNamesRoute)
    startedAtRef.current = runtime.now()
    setState(sessionRef.current.state)
    setPageReady(sessionRef.current.pageReady)
    setPageFrame(shellPageFrame(sessionRef.current))
    setBackClaimed(shellPageBackClaimed(sessionRef.current))
    if (retained !== null) {
      runEffectRef.current?.(epochRef.current, retained.flow, { kind: 'read-manifest' })
    }
  }, [appNamesRoute, hostId, invalidate, routePathname, runtime])

  useEffect(() => invalidate, [invalidate])

  // Log-only: one warning per parked state object, cancelled by any state, paint, host or route change.
  // `CHECKING` is one shared object, so checking-to-checking steps keep the first open's timer.
  useEffect(() => {
    if (shellStallLine(state, sessionRef.current, logTraceRef.current) === null) {
      return
    }
    return runtime.setForegroundTimer(() => {
      const line = shellStallLine(state, sessionRef.current, logTraceRef.current)
      if (line !== null) {
        recordShellLifecycleLine(hostIdRef.current, line)
      }
    }, SHELL_STALL_LOG_MS)
  }, [hostId, pageFrame, routePathname, runtime, state])

  useEffect(() => {
    dispatch(epochRef.current, { type: 'layout-changed', wide })
  }, [dispatch, wide])

  const liveGates = useHostProtocolGates()
  const provenStatus = useMobileWebShellGates({
    gates: liveGates,
    connState,
    client,
    rearmKey: `${hostId}\0${routePathname}`,
    onGates: useCallback(
      (nextGates) => dispatch(epochRef.current, { type: 'gates-changed', gates: nextGates }),
      [dispatch]
    )
  })

  // Judge the live gates against the shown document's own window in this render, so no commit trusts gates the reducer has not seen.
  const hostStatus =
    state.kind === 'ready' &&
    documentMayTalk(state.compat, {
      statusPending: liveGates.statusPending,
      statusReadable: liveGates.statusReadable,
      reachability: readMobileWebShellReachability(connState, client),
      hostCapabilities: liveGates.hostCapabilities,
      hostStatus: liveGates.hostProtocolWindow
    })
      ? provenStatus
      : null

  const retry = useCallback(() => {
    // A fresh epoch first: a failed download still in flight must not land on the retried session.
    evictRetainedShellSessionForHost(hostIdRef.current, routePathname)
    invalidate()
    startedAtRef.current = runtime.now()
    dispatch(epochRef.current, { type: 'retry-pressed' })
  }, [dispatch, invalidate, routePathname, runtime])

  // A remount mints the replacement's session before React commits it; drop reports queued by the view it retired.
  const viewSessionId = state.kind === 'ready' ? state.sessionId : null
  const reportFromView = useCallback(
    (event: MobileWebShellSessionEvent): void => {
      const live = sessionRef.current.state
      if (viewSessionId === null || (live.kind === 'ready' && live.sessionId === viewSessionId)) {
        dispatch(epochRef.current, event)
      }
    },
    [dispatch, viewSessionId]
  )

  const reportShellFailure = useCallback(
    (reason: MobileWebShellReportedFailure, reclaimed = false) => {
      const event = { type: 'shell-failed', reason, reclaimed } as const
      const fromScreen = reason === 'host-profile-unreadable'
      const live = sessionRef.current.state
      const accepted =
        fromScreen ||
        viewSessionId === null ||
        (live.kind === 'ready' && live.sessionId === viewSessionId)
      // A failed shell must not be reused on the next 0ms re-entry.
      if (accepted) {
        evictRetainedShellSessionForHost(hostIdRef.current, routePathname)
      }
      // Profile reads come from the screen, not the view, so no retired document can send one.
      if (fromScreen) {
        dispatch(epochRef.current, event)
        return
      }
      reportFromView(event)
    },
    [dispatch, reportFromView, routePathname, viewSessionId]
  )

  const reportDocumentStarted = useCallback(
    () => reportFromView({ type: 'document-started' }),
    [reportFromView]
  )

  const reportDocumentLoaded = useCallback(
    () => reportFromView({ type: 'document-loaded' }),
    [reportFromView]
  )

  const reportPageReady = useCallback(
    () => reportFromView({ type: 'page-ready' }),
    [reportFromView]
  )

  const reportPagePainted = useCallback(
    () => reportFromView({ type: 'page-painted' }),
    [reportFromView]
  )

  const reportPageBackClaim = useCallback(
    (claimed: boolean) => reportFromView({ type: 'page-back-claim', claimed }),
    [reportFromView]
  )

  const reportSwapSafe = useResumeSwapConsent(holdRef, hostId, () =>
    dispatch(epochRef.current, { type: 'app-resumed' })
  )

  return {
    state,
    downloadProgress,
    pageReady,
    pageFrame,
    pageRoutes: sessionRef.current.pageRoutes,
    pageRouteGrants: sessionRef.current.pageRouteGrants,
    routeGrants: sessionRef.current.routeGrants,
    ownsHostArea: sessionRef.current.ownsHostArea,
    hostStatus,
    updateNotice: sessionRef.current.updateNotice,
    retry,
    reportShellFailure,
    reportDocumentStarted,
    reportDocumentLoaded,
    reportPageReady,
    reportPagePainted,
    reportPageBackClaim,
    reportSwapSafe,
    backClaimed,
    store
  }
}
