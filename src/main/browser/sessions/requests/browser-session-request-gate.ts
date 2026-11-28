import type { Session } from 'electron'

import {
  getProxySessionApplicationReadiness,
  isProxySessionApplicationReady
} from '../../../network/proxy-settings'
import { onProxySessionReadinessChanged } from '../../../network/proxy-session-readiness-listeners'
import { answerBrowserSessionBeforeRequest } from './browser-session-request-decisions'
import { reportBrowserSessionWebRequest } from './browser-session-web-request-observer'
import { holdBrowserSessionWebRequest } from './browser-session-web-request-owner'

// Keyed by object so proxy readiness notices find their session without a scan.
const gatedSessions = new Map<
  object,
  {
    session: Session
    release: (() => void) | null
    mode: GateMode | null
    stop: () => void
  }
>()

// 'full' sees every request; 'unspecified' only 0.0.0.0/[::] ones, so ordinary requests skip main.
type GateMode = 'full' | 'unspecified'

// Sessions whose loopback-only proxy would send 0.0.0.0/[::] to this machine: a teammate's pages.
const redirectUnspecifiedSessions = new WeakSet<Session>()

// `*://` matches only http/https, so WebSocket schemes are listed too (t3code LoopbackTunnel.ts:61-76).
const UNSPECIFIED_ADDRESS_FILTER: Electron.WebRequestFilter = {
  urls: ['http', 'https', 'ws', 'wss'].flatMap((scheme) => [
    `${scheme}://0.0.0.0/*`,
    `${scheme}://[::]/*`
  ])
}

// Holders that need every request seen: a profile whose extensions are still loading (their rules
// must hold requests).
const gateHoldsBySession = new Map<Session, number>()

onProxySessionReadinessChanged((proxySession) => {
  const gated = gatedSessions.get(proxySession)
  if (gated) {
    refresh(gated.session)
  }
})

/**
 * Any session listener makes every page request wait on main (Electron's per-request loader
 * gate), so the gate listens only while it can change an outcome: until the session's newest
 * proxy policy applies (requests fail closed rather than leave unproxied, including after a
 * failed or retired policy), while extensions need request decisions, and while a holder needs it.
 */
function refresh(session: Session): void {
  const gated = gatedSessions.get(session)
  if (!gated) {
    return
  }
  const needed =
    gateHoldsBySession.has(session) ||
    !isProxySessionApplicationReady(session) ||
    (session.extensions?.getAllExtensions().length ?? 0) > 0
  const mode: GateMode | null = needed
    ? 'full'
    : redirectUnspecifiedSessions.has(session)
      ? 'unspecified'
      : null
  if (mode === gated.mode) {
    return
  }
  gated.release?.()
  gated.release = mode === 'full' ? listen(session) : mode ? listenUnspecified(session) : null
  gated.mode = mode
}

/** A teammate's page asking for 0.0.0.0/[::] means the host's dev server (as the host's own
 *  browser reads it), not this machine: it goes to loopback, which the proxy sends to the host. */
export function redirectUnspecifiedToLoopback(url: string): Electron.CallbackResponse | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.hostname !== '0.0.0.0' && parsed.hostname !== '[::]') {
    return null
  }
  // A WebSocket handshake can't be redirected.
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
    return { cancel: true }
  }
  // Keeps the address family, as remote-browser-socks-server's listener wildcard does.
  parsed.hostname = parsed.hostname === '[::]' ? '[::1]' : '127.0.0.1'
  return { redirectURL: parsed.toString() }
}

function listenUnspecified(session: Session): () => void {
  return holdBrowserSessionWebRequest(
    session,
    'onBeforeRequest',
    (details, callback) => callback(redirectUnspecifiedToLoopback(details.url) ?? {}),
    UNSPECIFIED_ADDRESS_FILTER
  )
}

export function setBrowserSessionRedirectUnspecifiedToLoopback(
  session: Session,
  enabled: boolean
): void {
  if (enabled) {
    redirectUnspecifiedSessions.add(session)
  } else {
    redirectUnspecifiedSessions.delete(session)
  }
  refresh(session)
}

function listen(session: Session): () => void {
  return holdBrowserSessionWebRequest(session, 'onBeforeRequest', (details, callback) => {
    reportBrowserSessionWebRequest(session, 'onBeforeRequest', details)
    const redirected = redirectUnspecifiedSessions.has(session)
      ? redirectUnspecifiedToLoopback(details.url)
      : null
    if (redirected) {
      callback(redirected)
      return
    }
    // Rechecked after every wait: a newer policy can start applying before the held request leaves.
    const decide = (): void => {
      const readiness = getProxySessionApplicationReadiness(session)
      if (readiness === true) {
        answerBrowserSessionBeforeRequest(session, details, callback)
      } else if (readiness === false) {
        callback({ cancel: true })
      } else {
        void readiness.then((ready) => (ready ? decide() : callback({ cancel: true })))
      }
    }
    decide()
  })
}

export function installBrowserSessionRequestGate(session: Session): void {
  if (gatedSessions.has(session)) {
    return
  }
  const onExtensionsChanged = (): void => refresh(session)
  session.extensions?.on('extension-loaded', onExtensionsChanged)
  session.extensions?.on('extension-unloaded', onExtensionsChanged)
  gatedSessions.set(session, {
    session,
    release: null,
    mode: null,
    stop: () => {
      session.extensions?.off('extension-loaded', onExtensionsChanged)
      session.extensions?.off('extension-unloaded', onExtensionsChanged)
    }
  })
  refresh(session)
}

export function removeBrowserSessionRequestGate(session: Session): void {
  const gated = gatedSessions.get(session)
  if (!gated) {
    return
  }
  gatedSessions.delete(session)
  redirectUnspecifiedSessions.delete(session)
  gated.stop()
  gated.release?.()
}

/** Listens until released. */
export function holdBrowserSessionRequestGate(session: Session): () => void {
  gateHoldsBySession.set(session, (gateHoldsBySession.get(session) ?? 0) + 1)
  refresh(session)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const remaining = (gateHoldsBySession.get(session) ?? 1) - 1
    if (remaining > 0) {
      gateHoldsBySession.set(session, remaining)
    } else {
      gateHoldsBySession.delete(session)
    }
    refresh(session)
  }
}
