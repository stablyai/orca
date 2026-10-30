import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHostProtocolGates } from '../components/host-protocol-gates-context'
import { useHostClient } from '../transport/host-client-hooks'
import {
  createDownloadProgressFeed,
  downloadFraction,
  type DownloadProgressFeed
} from './download-progress-feed'
import type { GenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { download, openCache, readManifest } from './mobile-web-shell-session-effects'
import {
  createMobileWebShellRuntime,
  DOCUMENT_LOAD_DEADLINE_MS,
  PAGE_READY_DEADLINE_MS,
  type MobileWebShellRuntime
} from './mobile-web-shell-runtime'
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
  createMobileWebShellSession,
  reduceMobileWebShellSession
} from './mobile-web-shell-session'
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
  // Explain fallback beside the running page without replacing it.
  readonly updateNotice: MobileWebShellUpdateNotice | null
  readonly retry: () => void
  readonly reportShellFailure: (reason: MobileWebShellReportedFailure) => void
  readonly reportDocumentStarted: () => void
  readonly reportDocumentLoaded: () => void
  readonly reportPageReady: () => void
  readonly reportPagePainted: () => void
  readonly reportPageBackClaim: (claimed: boolean) => void
  // Project document facts into React state: page-ready alone changes no session-state identity to trigger a render.
  readonly pageReady: boolean
  // Project paint for the same reason: the ready state itself does not change.
  readonly pageFrame: ShellPageFrame
  // Project Back claims so claim-only events still rerender.
  readonly backClaimed: boolean
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

  const runtimeRef = useRef<MobileWebShellRuntime | null>(null)
  runtimeRef.current ??= args.runtime ?? createMobileWebShellRuntime()
  const runtime = runtimeRef.current
  const storeRef = useRef<GenerationStore | null>(null)
  storeRef.current ??= runtime.createStore()

  const sessionRef = useRef(createMobileWebShellSession(routePathname, wide, appNamesRoute))
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
  // Cancel deadlines too; epoch guards alone leave real timers alive until expiry.
  const timersRef = useRef<Set<() => void>>(new Set())
  const hostIdRef = useRef(hostId)
  const logTraceRef = useRef(EMPTY_SHELL_LOG_TRACE)
  const runEffectRef = useRef<
    ((epoch: number, flow: number, effect: MobileWebShellSessionEffect) => void) | null
  >(null)

  const cancelPending = useCallback((): void => {
    downloadsRef.current.forEach((controller) => controller.abort())
    downloadsRef.current.clear()
    timersRef.current.forEach((cancel) => cancel())
    timersRef.current.clear()
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
      if (stepped.session.flow !== previous.flow) {
        cancelPending()
      }
      const next = stepped.session.state
      if (next.kind === 'fetching') {
        downloadProgress.publish(downloadFraction(next.receivedBytes, next.totalBytes))
      }
      setState(next)
      setPageReady(stepped.session.pageReady)
      setPageFrame(shellPageFrame(stepped.session))
      setBackClaimed(shellPageBackClaimed(stepped.session))
      for (const effect of stepped.effects) {
        // Echo the resulting flow so reducer restarts can reject superseded completions.
        runEffectRef.current?.(epoch, stepped.session.flow, effect)
      }
    },
    [cancelPending, downloadProgress]
  )

  const invalidate = useCallback((): void => {
    epochRef.current += 1
    cancelPending()
  }, [cancelPending])

  const runEffect = useCallback(
    async (epoch: number, flow: number, effect: MobileWebShellSessionEffect): Promise<void> => {
      const store = storeRef.current
      if (store === null) {
        return
      }
      const send = (event: MobileWebShellSessionEvent) => dispatch(epoch, event)
      switch (effect.kind) {
        case 'delete-cache':
          // No completion event needed: the store queue orders the following sweep/read after deletion.
          await store.deleteHostCache(hostKey).catch(() => undefined)
          return
        case 'record-update-failure':
          // The runner owns host/time; best-effort store failures must not affect the decision.
          await store.recordUpdateFailure({ ...effect.failure, hostId, at: runtime.now() })
          return
        case 'forget-update-failures':
          await store.forgetHostUpdateFailures(hostId)
          return
        case 'open-cache':
          send({ type: 'cache-read', flow, generation: await openCache(store, hostKey) })
          return
        case 'read-manifest':
          await readManifest(client, flow, send)
          return
        case 'download':
          await download({
            client,
            store,
            hostKey,
            flow,
            runtime,
            startedAt: startedAtRef.current,
            downloads: downloadsRef.current,
            send
          })
          return
        case 'open-generation':
          send({
            type: 'activated',
            flow,
            generationDirectory: effect.directory,
            sessionId: runtime.mintSessionId(),
            buildId: effect.buildId,
            totalBytes: effect.totalBytes,
            elapsedMs: runtime.now() - startedAtRef.current
          })
          return
        case 'remount':
          send({ type: 'remounted', flow, sessionId: runtime.mintSessionId() })
          return
        case 'await-page-ready':
        case 'await-document-load': {
          const pageReady = effect.kind === 'await-page-ready'
          const cancel = runtime.setTimer(
            () => {
              timersRef.current.delete(cancel)
              send({ type: pageReady ? 'page-ready-deadline' : 'document-load-deadline', flow })
            },
            pageReady ? PAGE_READY_DEADLINE_MS : DOCUMENT_LOAD_DEADLINE_MS
          )
          timersRef.current.add(cancel)
        }
      }
    },
    [client, dispatch, hostId, hostKey, runtime]
  )
  // Install the runner after commit, before dispatching effects, so discarded renders cannot execute work.
  useEffect(() => {
    runEffectRef.current = (epoch, flow, effect) => {
      void runEffect(epoch, flow, effect)
    }
  }, [runEffect])

  useEffect(() => {
    invalidate()
    hostIdRef.current = hostId
    logTraceRef.current = EMPTY_SHELL_LOG_TRACE
    sessionRef.current = createMobileWebShellSession(routePathname, wide, appNamesRoute)
    startedAtRef.current = runtime.now()
    setState(sessionRef.current.state)
    setPageReady(sessionRef.current.pageReady)
    setPageFrame(shellPageFrame(sessionRef.current))
    return invalidate
  }, [appNamesRoute, hostId, invalidate, routePathname, runtime])

  // Log once per parked state identity; shared CHECKING keeps its first timer through checking-to-checking steps.
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

  const { statusPending, statusReadable, hostCapabilities, hostProtocolWindow } = gates
  const reachability = readMobileWebShellReachability(connState, client)
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
    // Host and pathname rebuild the session; re-arm even on an unchanged verdict or the fresh session would remain checking.
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
    invalidate()
    startedAtRef.current = runtime.now()
    dispatch(epochRef.current, { type: 'retry-pressed' })
  }, [dispatch, invalidate, runtime])

  const reportShellFailure = useCallback(
    (reason: MobileWebShellReportedFailure) => {
      dispatch(epochRef.current, { type: 'shell-failed', reason })
    },
    [dispatch]
  )

  const reportDocumentStarted = useCallback(() => {
    dispatch(epochRef.current, { type: 'document-started' })
  }, [dispatch])

  const reportDocumentLoaded = useCallback(() => {
    dispatch(epochRef.current, { type: 'document-loaded' })
  }, [dispatch])

  const reportPageReady = useCallback(() => {
    dispatch(epochRef.current, { type: 'page-ready' })
  }, [dispatch])

  const reportPagePainted = useCallback(() => {
    dispatch(epochRef.current, { type: 'page-painted' })
  }, [dispatch])

  const reportPageBackClaim = useCallback(
    (claimed: boolean) => {
      dispatch(epochRef.current, { type: 'page-back-claim', claimed })
    },
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
