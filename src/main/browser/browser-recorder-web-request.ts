// ---------------------------------------------------------------------------
// Browser action recorder — webRequest safety net
//
// Authoritative request capture via session.webRequest.onCompleted: catches
// requests the in-page hook cannot see (fired before injection, cross-origin
// frames, iframe form submits). A shared listener dispatches to every active
// recorder so concurrent sessions cannot clobber each other's listener.
// onCompleted carries no request body — enriched records come from the page
// hook; this net fills the gaps with bare records.
// ---------------------------------------------------------------------------

import type { Session } from 'electron'

export type BrowserRecorderWebRequestDetails = {
  url: string
  method: string
  statusCode: number
  resourceType: string
  webContentsId: number
  timestamp: number
}

type Listener = (details: BrowserRecorderWebRequestDetails) => void

const observersBySession = new Map<Session, Set<Listener>>()

// Why: resource types that represent data exchange (not asset downloads).
const RECORDED_RESOURCE_TYPES = new Set(['xhr', 'fetch', 'subFrame'])

export class BrowserRecorderWebRequest {
  /**
   * Registers a listener for completed requests of one webContents. Returns a
   * detach function. Only one Electron listener is attached per session,
   * regardless of how many recorders subscribe.
   */
  static attach(session: Session, webContentsId: number, listener: Listener): () => void {
    let listeners = observersBySession.get(session)
    if (!listeners) {
      listeners = new Set()
      observersBySession.set(session, listeners)
      const currentListeners = listeners
      session.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (details) => {
        for (const observer of currentListeners) {
          observer({
            url: details.url ?? '',
            method: details.method ?? 'GET',
            statusCode: details.statusCode ?? 0,
            resourceType: details.resourceType ?? 'other',
            webContentsId: details.webContentsId ?? -1,
            timestamp: details.timestamp ?? Date.now()
          })
        }
      })
    }
    const scoped: Listener = (details) => {
      if (
        details.webContentsId === webContentsId &&
        RECORDED_RESOURCE_TYPES.has(details.resourceType)
      ) {
        listener(details)
      }
    }
    listeners.add(scoped)
    return () => {
      listeners.delete(scoped)
      if (listeners.size === 0) {
        session.webRequest.onCompleted(null)
        observersBySession.delete(session)
      }
    }
  }
}
