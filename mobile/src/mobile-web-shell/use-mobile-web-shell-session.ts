import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import { useHostProtocolGates } from '../components/HostProtocolGate'
import { useHostClient } from '../transport/client-context'
import type { GenerationStore } from './generation-store'
import { deriveHostCacheKey } from './host-cache-key'
import { download, openCache, readManifest } from './mobile-web-shell-session-effects'
import {
  createMobileWebShellRuntime,
  PAGE_READY_DEADLINE_MS,
  type MobileWebShellRuntime
} from './mobile-web-shell-runtime'
import { readMobileWebShellReachability } from './mobile-web-shell-reachability'
import { shellPageBackClaimed } from './shell-page-back-claim'
import { shellPageFrame, type ShellPageFrame } from './shell-page-frame'
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
  /** The route patterns this shell would render from the page, for the page to be told about. */
  readonly pageRoutes: readonly string[]
  readonly pageRouteGrants: readonly { pathname: string; grants: readonly string[] }[]
  readonly routeGrants: readonly string[]
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
  /** The page spoke over the bridge; ends that wait, whichever of the two arrived first. Carries
   *  what that `ready` declared it reports, which is what says whether a paint is coming. */
  readonly reportPageReady: (reports: readonly string[]) => void
  /** The page has a frame on screen. Ignored for a page that never said it would report one. */
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
  runtime?: MobileWebShellRuntime
}): MobileWebShellSessionView {
  const { hostId, routePathname } = args
  const gates = useHostProtocolGates()
  const { client, state: connState } = useHostClient(hostId)

  const runtimeRef = useRef<MobileWebShellRuntime | null>(null)
  runtimeRef.current ??= args.runtime ?? createMobileWebShellRuntime()
  const runtime = runtimeRef.current
  const storeRef = useRef<GenerationStore | null>(null)
  storeRef.current ??= runtime.createStore()

  const sessionRef = useRef(createMobileWebShellSession(routePathname))
  const [state, setState] = useState(sessionRef.current.state)
  const [pageReady, setPageReady] = useState(sessionRef.current.pageReady)
  const [pageFrame, setPageFrame] = useState(() => shellPageFrame(sessionRef.current))
  const [backClaimed, setBackClaimed] = useState(() => shellPageBackClaimed(sessionRef.current))
  const hostKey = useMemo(() => deriveHostCacheKey(hostId), [hostId])
  const startedAtRef = useRef(runtime.now())
  // Bumped by anything that invalidates work in flight; every dispatch out of an effect checks it.
  const epochRef = useRef(0)
  // Aborted on the same bump: a download nobody will use still holds four of the host's read slots.
  const downloadsRef = useRef<Set<AbortController>>(new Set())
  // Cancelled on the same bump, for the same reason: an armed deadline belongs to the generation it
  // was armed under, and the epoch check alone would leave a real timer alive until it fired.
  const timersRef = useRef<Set<() => void>>(new Set())
  const runEffectRef = useRef<
    ((epoch: number, flow: number, effect: MobileWebShellSessionEffect) => void) | null
  >(null)

  const dispatch = useCallback((epoch: number, event: MobileWebShellSessionEvent): void => {
    if (epoch !== epochRef.current) {
      return
    }
    const stepped = reduceMobileWebShellSession(sessionRef.current, event)
    sessionRef.current = stepped.session
    setState(stepped.session.state)
    setPageReady(stepped.session.pageReady)
    setPageFrame(shellPageFrame(stepped.session))
    setBackClaimed(shellPageBackClaimed(stepped.session))
    for (const effect of stepped.effects) {
      // Every effect of a step belongs to the flow that step produced, and its result carries that
      // number back, so a flow the session has since restarted reports into nothing.
      runEffectRef.current?.(epoch, stepped.session.flow, effect)
    }
  }, [])

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
      if (store === null) {
        return
      }
      const send = (event: MobileWebShellSessionEvent) => dispatch(epoch, event)
      switch (effect.kind) {
        case 'delete-cache':
          // Reports nothing: the store serialises its own queue, so the sweep and read the reducer
          // queued behind this one already run after it.
          await store.deleteHostCache(hostKey).catch(() => undefined)
          return
        case 'persist-manifest':
          // Nothing is reported back and a failure is swallowed: the routes the page is mounted
          // under are already on the session, so all a refused or failed write costs is the
          // freshness of the next offline verdict, never the generation being opened here.
          await store.persistActiveManifest(hostKey, effect.manifest).catch(() => undefined)
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
        case 'await-page-ready': {
          const cancel = runtime.setTimer(() => {
            timersRef.current.delete(cancel)
            send({ type: 'page-ready-deadline', flow })
          }, PAGE_READY_DEADLINE_MS)
          timersRef.current.add(cancel)
          return
        }
      }
    },
    [client, dispatch, hostKey, runtime]
  )
  // Written after the commit, never during render: React may replay or discard a render, and a
  // closure from one that never committed would run effects for a session that never existed.
  // Declared above every effect that dispatches, so the first one already finds it.
  useEffect(() => {
    runEffectRef.current = (epoch, flow, effect) => {
      void runEffect(epoch, flow, effect)
    }
  }, [runEffect])

  useEffect(() => {
    // A new host is a new session: the old one's latches, cache handle and in-flight work all go.
    invalidate()
    sessionRef.current = createMobileWebShellSession(routePathname)
    startedAtRef.current = runtime.now()
    setState(sessionRef.current.state)
    setPageReady(sessionRef.current.pageReady)
    setPageFrame(shellPageFrame(sessionRef.current))
    return invalidate
  }, [hostId, invalidate, routePathname, runtime])

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
    invalidate()
    startedAtRef.current = runtime.now()
    dispatch(epochRef.current, { type: 'retry-pressed' })
  }, [dispatch, invalidate, runtime])

  const reportShellFailure = useCallback(
    (reason: MobileWebShellFailureReason) => {
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

  const reportPageReady = useCallback(
    (reports: readonly string[]) => {
      dispatch(epochRef.current, { type: 'page-ready', reports })
    },
    [dispatch]
  )

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
    pageReady,
    pageFrame,
    pageRoutes: sessionRef.current.pageRoutes,
    pageRouteGrants: sessionRef.current.pageRouteGrants,
    routeGrants: sessionRef.current.routeGrants,
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
