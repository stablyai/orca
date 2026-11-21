import type { Session } from 'electron'

import { getProxySessionApplicationReadiness } from '../../../network/proxy-settings'
import { onProxySessionReadinessChanged } from '../../../network/proxy-session-readiness-listeners'
import { answerBrowserSessionBeforeRequest } from './browser-session-request-decisions'
import { reportBrowserSessionWebRequest } from './browser-session-web-request-observer'
import { holdBrowserSessionWebRequest } from './browser-session-web-request-owner'

// Keyed by object so proxy readiness notices find their session without a scan.
const gatedSessions = new Map<
  object,
  { session: Session; release: (() => void) | null; stop: () => void }
>()

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
 * failed or retired policy), and while extensions need request decisions.
 */
function refresh(session: Session): void {
  const gated = gatedSessions.get(session)
  if (!gated) {
    return
  }
  const needed =
    getProxySessionApplicationReadiness(session) !== true ||
    (session.extensions?.getAllExtensions().length ?? 0) > 0
  if (needed && !gated.release) {
    gated.release = listen(session)
  } else if (!needed && gated.release) {
    gated.release()
    gated.release = null
  }
}

function listen(session: Session): () => void {
  return holdBrowserSessionWebRequest(session, 'onBeforeRequest', (details, callback) => {
    reportBrowserSessionWebRequest(session, 'onBeforeRequest', details)
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
  gated.stop()
  gated.release?.()
}
