import type { Session } from 'electron'
import {
  browserSessionHasSiteList,
  onBrowserProfileSiteListsChanged
} from '../site-list/browser-session-site-list'

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
  { session: Session; release: (() => void) | null; stop: () => void }
>()

// Holders that need every request seen: a profile whose extensions are still loading (their rules
// must hold requests).
const gateHoldsBySession = new Map<Session, number>()

onProxySessionReadinessChanged((proxySession) => {
  const gated = gatedSessions.get(proxySession)
  if (gated) {
    refresh(gated.session)
  }
})

onBrowserProfileSiteListsChanged(() => {
  for (const { session } of gatedSessions.values()) {
    refresh(session)
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
    browserSessionHasSiteList(session) ||
    gateHoldsBySession.has(session) ||
    !isProxySessionApplicationReady(session) ||
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
