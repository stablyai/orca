import { useCallback, useLayoutEffect, useRef } from 'react'
import type {
  MobileWebShellBridgeMessagePayload,
  OrcaMobileWebShellViewHandle
} from '../../modules/orca-mobile-web-shell/src'
import { useHostClient } from '../transport/client-context'
import { createBridgeHost, type BridgeHost, type BridgeHostDiagnostic } from './bridge-host'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'

class BridgeViewGoneError extends Error {
  constructor() {
    super('the shell view for this session is not mounted')
    this.name = 'BridgeViewGoneError'
  }
}

/**
 * One line per kind, for the life of one host.
 *
 * A page that is failing frames fails all of them, and a line each buries the first — the one that
 * says why. The host already holds `post-failed` to one; this is the same bound for the kinds it
 * does not, and a new host starts the count over because a new page is new evidence.
 */
function createBridgeDiagnosticReporter(): (diagnostic: BridgeHostDiagnostic) => void {
  const reported = new Set<BridgeHostDiagnostic['kind']>()
  return (diagnostic) => {
    if (reported.has(diagnostic.kind)) {
      return
    }
    reported.add(diagnostic.kind)
    if (diagnostic.kind === 'refused') {
      console.warn('[web-shell-bridge] refused a page frame', diagnostic.refusal)
      return
    }
    if (diagnostic.kind === 'post-failed') {
      console.warn('[web-shell-bridge] the page could not be posted to', diagnostic.error)
      return
    }
    if (diagnostic.kind === 'notify-failed') {
      console.warn('[web-shell-bridge] the client threw on a page notification', diagnostic.error)
      return
    }
    console.warn('[web-shell-bridge] a view outlived its host and is still posting')
  }
}

/**
 * Both halves are stamped with the session they belong to.
 *
 * React swaps refs in the commit phase and runs the retiring effect's cleanup after it, so a host
 * disposing on a remount would otherwise post its teardown frames into the page that replaced it.
 */
type MountedView = { sessionId: string; handle: OrcaMobileWebShellViewHandle }
type MountedHost = { sessionId: string; host: BridgeHost }

/** Exactly the field the handler reads. The view's own `NativeSyntheticEvent` prop type is
 *  assignable to this, and a handler declared this narrowly is one a test can call honestly. */
export type MobileWebShellBridgeMessageEvent = {
  readonly nativeEvent: MobileWebShellBridgeMessagePayload
}

export type MobileWebShellBridgeView = {
  /**
   * Changing this prop re-enters the native load, so it is derived from the session step alone and
   * is constant for the life of a mount. A ready session whose client has not arrived yet gets the
   * channel and no host: there is no honest `init` to answer with, and `ready` is answered every
   * time it is asked so the page can ask again.
   */
  readonly bridgeEnabled: boolean
  readonly viewRef: (handle: OrcaMobileWebShellViewHandle | null) => void
  readonly onBridgeMessage: (event: MobileWebShellBridgeMessageEvent) => void
}

/**
 * Wires B4's session to one bridge host: the session the reducer put on screen owns the channel,
 * and nothing here mints, retries or decides anything.
 *
 * The session id is B4's — a remount is a new one, which is what makes a dead page's frames fail
 * the native origin check rather than reach a live client.
 */
export function useMobileWebShellBridge(args: {
  hostId: string
  session: MobileWebShellSessionState
}): MobileWebShellBridgeView {
  const { client } = useHostClient(args.hostId)
  const ready = args.session.kind === 'ready' ? args.session : null
  const sessionId = ready?.sessionId ?? null
  const buildId = ready?.buildId ?? null
  const viewRef = useRef<MountedView | null>(null)
  const hostRef = useRef<MountedHost | null>(null)

  // Commit-phase, not passive: a native frame that arrives between the two carries the session id
  // the handler is fenced on, so only handing the host over here keeps it off the retired client.
  useLayoutEffect(() => {
    if (client === null || sessionId === null || buildId === null) {
      return
    }
    const host = createBridgeHost({
      client,
      buildId,
      sessionId,
      post: (json) => {
        const mounted = viewRef.current
        return mounted === null || mounted.sessionId !== sessionId
          ? Promise.reject(new BridgeViewGoneError())
          : mounted.handle.postBridgeMessage(json)
      },
      onDiagnostic: createBridgeDiagnosticReporter()
    })
    hostRef.current = { sessionId, host }
    return () => {
      hostRef.current = null
      host.dispose()
    }
  }, [buildId, client, sessionId])

  return {
    bridgeEnabled: ready !== null,
    viewRef: useCallback(
      (handle: OrcaMobileWebShellViewHandle | null) => {
        viewRef.current = handle === null || sessionId === null ? null : { sessionId, handle }
      },
      [sessionId]
    ),
    onBridgeMessage: useCallback(
      (event: MobileWebShellBridgeMessageEvent) => {
        const mounted = hostRef.current
        if (mounted === null || mounted.sessionId !== sessionId) {
          return
        }
        mounted.host.receive(event.nativeEvent.json)
      },
      [sessionId]
    )
  }
}
