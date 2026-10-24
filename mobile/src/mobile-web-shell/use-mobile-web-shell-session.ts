import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { useHostClient } from '../transport/host-client-hooks'
import {
  createDownloadProgressFeed,
  downloadFraction,
  type DownloadProgressFeed
} from './download-progress-feed'
import type { GenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { runMobileWebShellSessionEffect } from './mobile-web-shell-session-effects'
import { createMobileWebShellRuntime, type MobileWebShellRuntime } from './mobile-web-shell-runtime'
import { readMobileWebShellReachability } from './mobile-web-shell-reachability'
import { shellPageBackClaimed } from './shell-page-back-claim'
import { recordShellLifecycleLine } from './shell-lifecycle-line-recorder'
import {
  EMPTY_SHELL_LOG_TRACE,
  SHELL_STALL_LOG_MS,
  shellSessionStepLines,
  shellStallLine,
  traceShellStep
} from './shell-lifecycle-log'
import { shellPageFrame, type ShellPageFrame } from './shell-page-frame'
import {
  evictRetainedShellSessionForHost,
  readRetainedShellSession,
  recordSessionInRetainedStore
} from './retained-shell-session-store'
import {
  createMobileWebShellSession,
  reduceMobileWebShellSession
} from './mobile-web-shell-session'
import type {
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellSessionState,
  MobileWebShellUpdateNotice
} from './mobile-web-shell-session-contract'

export type MobileWebShellSessionView = {
  readonly state: MobileWebShellSessionState
  /** The download's progress as it is dispatched, ahead of the React commit that `state` waits on. */
  readonly downloadProgress: DownloadProgressFeed
  /** The route patterns this shell would render from the page, for the page to be told about. */
  readonly pageRoutes: readonly string[]
  readonly pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[]
  readonly routeGrants: readonly string[]
  readonly ownsHostArea: boolean
  /** Non-null when this generation is a fallback from an update the shell refused, for the caller
   *  to say so beside the page rather than instead of it. */
  readonly updateNotice: MobileWebShellUpdateNotice | null
  readonly retry: () => void
  /** B3's failure reasons, forwarded verbatim; the reducer owns what each one means. */
  readonly reportShellFailure: (reason: MobileWebShellFailureReason) => void
  /** The native view began a document; drops what the document it replaces said about itself. */
  readonly reportDocumentStarted: () => void
  /** The native view finished a document; starts the wait for the page's first word. */
  readonly reportDocumentLoaded: () => void
  /** The page spoke over the bridge; ends that wait, whichever of the two arrived first. */
  readonly reportPageReady: () => void
  /** The page has a frame on screen. */
  readonly reportPagePainted: () => void
  /** The page took the device Back key, or let it go. */
  readonly reportPageBackClaim: (claimed: boolean) => void
  /**
   * Whether the page has handshaken on this session, which the bridge host is rebuilt against.
   *
   * Projected into state beside `state` rather than read off the ref while rendering: a
   * `page-ready` changes nothing else, so no other value would re-render to carry it out.
   */
  readonly pageReady: boolean
  /** How far this document has got towards being something to show. Projected for the same
   *  reason as `pageReady`: `page-painted` moves nothing else. */
  readonly pageFrame: ShellPageFrame
  /** Whether the shell should take Back off the navigator. Projected for the same reason as
   *  `pageReady`: a claim moves nothing else, so no other value would re-render to carry it. */
  readonly backClaimed: boolean
}

/**
 * Drives one hybrid shell session for one host: the reducer decides, this runs what it asks for.
 *
 * Every effect result is checked against an epoch before it is dispatched, so an unmount, a host
 * change or a retry abandons work in flight instead of applying it to the next session. Nothing
 * here decides anything — a rule that lived in this file would be a rule with no table test.
 */
export function useMobileWebShellSession(args: {
  hostId: string
  /** The route this mount stands for, matched against the page routes the bundle declares. */
  routePathname: string
  /** A wide layout; a change restarts the session only where it changes the answer. */
  wide?: boolean
  /** False when this app has no screen of its own for the route. */
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
  const storeRef = useRef<GenerationStore | null>(null)
  storeRef.current ??= runtime.createStore()

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
  // Bumped by anything that invalidates work in flight; every dispatch out of an effect checks it.
  const epochRef = useRef(0)
  // Aborted on the same bump: a download nobody will use still holds four of the host's read slots.
  const downloadsRef = useRef<Set<AbortController>>(new Set())
  // Cancelled on the same bump, for the same reason: an armed deadline belongs to the generation it
  // was armed under, and the epoch check alone would leave a real timer alive until it fired.
  const timersRef = useRef<Set<() => void>>(new Set())
  // The log's host for `dispatch`, which is stable; moved with the session rebuild below.
  const hostIdRef = useRef(hostId)
  const logTraceRef = useRef(EMPTY_SHELL_LOG_TRACE)
  const runEffectRef = useRef<
    ((epoch: number, flow: number, effect: MobileWebShellSessionEffect) => void) | null
  >(null)

  const dispatch = useCallback(
    (epoch: number, event: MobileWebShellSessionEvent): void => {
      if (epoch !== epochRef.current) {
        return
      }
      const stepped = reduceMobileWebShellSession(sessionRef.current, event)
      const trace = traceShellStep(logTraceRef.current, sessionRef.current, event, stepped.session)
      logTraceRef.current = trace
      for (const line of shellSessionStepLines(sessionRef.current, event, stepped.session, trace)) {
        recordShellLifecycleLine(hostIdRef.current, line)
      }
      sessionRef.current = stepped.session
      recordSessionInRetainedStore(hostIdRef.current, clientRef.current, stepped.session)
      const next = stepped.session.state
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
    [downloadProgress]
  )

  const invalidate = useCallback((): void => {
    epochRef.current += 1
    for (const controller of downloadsRef.current) {
      controller.abort()
    }
    downloadsRef.current.clear()
    for (const cancel of timersRef.current) {
      cancel()
    }
    timersRef.current.clear()
  }, [])

  const runEffect = useCallback(
    async (epoch: number, flow: number, effect: MobileWebShellSessionEffect): Promise<void> => {
      const store = storeRef.current
      if (store !== null) {
        await runMobileWebShellSessionEffect({
          effect,
          flow,
          client,
          store,
          hostId,
          hostKey,
          runtime,
          startedAt: startedAtRef.current,
          downloads: downloadsRef.current,
          timers: timersRef.current,
          send: (event) => dispatch(epoch, event)
        })
      }
    },
    [client, dispatch, hostId, hostKey, runtime]
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
    return runtime.setTimer(() => {
      const line = shellStallLine(state, sessionRef.current, logTraceRef.current)
      if (line !== null) {
        recordShellLifecycleLine(hostIdRef.current, line)
      }
    }, SHELL_STALL_LOG_MS)
  }, [hostId, pageFrame, routePathname, runtime, state])

  useEffect(() => {
    dispatch(epochRef.current, { type: 'layout-changed', wide })
  }, [dispatch, wide])

  useEffect(() => {
    dispatch(epochRef.current, {
      type: 'gates-changed',
      gates: {
        statusPending,
        statusReadable,
        reachability,
        hostCapabilities,
        hostStatus: hostProtocolWindow
      }
    })
    // `hostId` and `routePathname` are in the list because they are what rebuilds the session
    // above: the reducer starts nothing on a repeat verdict, so a fresh session nobody re-armed
    // would sit in `checking` forever. Both, not just the host, because either one rebuilds it.
  }, [
    dispatch,
    hostCapabilities,
    hostId,
    hostProtocolWindow,
    reachability,
    routePathname,
    statusPending,
    statusReadable
  ])

  const retry = useCallback(() => {
    // A fresh epoch first: a failed download still in flight must not land on the retried session.
    evictRetainedShellSessionForHost(hostIdRef.current, routePathname)
    invalidate()
    startedAtRef.current = runtime.now()
    dispatch(epochRef.current, { type: 'retry-pressed' })
  }, [dispatch, invalidate, routePathname, runtime])

  const reportShellFailure = useCallback(
    (reason: MobileWebShellFailureReason) => {
      evictRetainedShellSessionForHost(hostIdRef.current, routePathname)
      dispatch(epochRef.current, { type: 'shell-failed', reason })
    },
    [dispatch, routePathname]
  )

  const reportDocumentStarted = useCallback(() => dispatch(epochRef.current, { type: 'document-started' }), [dispatch])
  const reportDocumentLoaded = useCallback(() => dispatch(epochRef.current, { type: 'document-loaded' }), [dispatch])
  const reportPageReady = useCallback(() => dispatch(epochRef.current, { type: 'page-ready' }), [dispatch])
  const reportPagePainted = useCallback(() => dispatch(epochRef.current, { type: 'page-painted' }), [dispatch])
  const reportPageBackClaim = useCallback(
    (claimed: boolean) => dispatch(epochRef.current, { type: 'page-back-claim', claimed }),
    [dispatch]
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
    updateNotice: sessionRef.current.updateNotice,
    retry,
    reportShellFailure,
    reportDocumentStarted,
    reportDocumentLoaded,
    reportPageReady,
    reportPagePainted,
    reportPageBackClaim,
    backClaimed
  }
}
