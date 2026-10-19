import type {
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import { CLEAR_PAGE_DOCUMENT_STATE } from './page-document-state'
import { step } from './mobile-web-shell-session-step'

export const AWAIT_DOCUMENT_LOAD: MobileWebShellSessionEffect = { kind: 'await-document-load' }

export type PageDocumentLifecycleEvent = Extract<
  MobileWebShellSessionEvent,
  | { type: 'remounted' }
  | { type: 'document-started' }
  | { type: 'document-loaded' }
  | { type: 'page-ready-deadline' }
  | { type: 'document-load-deadline' }
>

/**
 * The view's own document, from start to the page's first word. `failDocument` is the reducer's
 * `document-load-failed` recovery, which drops the generation and fetches once.
 */
export function reducePageDocumentLifecycle(
  session: MobileWebShellSession,
  event: PageDocumentLifecycleEvent,
  failDocument: (session: MobileWebShellSession) => MobileWebShellStep
): MobileWebShellStep {
  switch (event.type) {
    case 'remounted':
      // Only the session id changes, so the view remounts against the same verified bytes. A new
      // key is a new document, so whatever the last one said is no longer evidence about this one.
      // The flow goes with it: the wait the retired document armed would otherwise expire onto a
      // healthy page that is still inside its own, and take a working workspace off screen.
      return session.state.kind === 'ready'
        ? step(
            session,
            {
              ...CLEAR_PAGE_DOCUMENT_STATE,
              flow: session.flow + 1,
              state: { ...session.state, sessionId: event.sessionId }
            },
            [AWAIT_DOCUMENT_LOAD]
          )
        : step(session, {})
    case 'document-started':
      // A replacement document inherits nothing: what the last one declared and painted says
      // nothing about this one, and leaving its paint latched uncovers the view over a blank tree.
      // The flow goes with it for the same reason `remounted` moves it — the retired document's
      // waits would otherwise expire onto a replacement that is still loading.
      return session.state.kind === 'ready'
        ? step(session, { ...CLEAR_PAGE_DOCUMENT_STATE, flow: session.flow + 1 }, [
            AWAIT_DOCUMENT_LOAD
          ])
        : step(session, {})
    case 'document-loaded':
      // Nothing to wait on outside `ready`, and nothing to wait for once the page has spoken: the
      // two orders this can arrive in are a race, and the latch is what makes either one fine.
      if (session.state.kind !== 'ready') {
        return step(session, {})
      }
      return session.pageReady
        ? step(session, { documentLoaded: true })
        : step(session, { documentLoaded: true }, [{ kind: 'await-page-ready' }])
    case 'page-ready-deadline':
      // A document that finished and never said a word is a document that did not load, whatever
      // the WebView reported.
      return session.pageReady ? step(session, {}) : failDocument(session)
    case 'document-load-deadline':
      // A refused or never-committed load reports nothing (iOS 18 cancelled its own document,
      // #28626), so without this the cover spins forever over a blank view.
      return session.state.kind !== 'ready' || session.documentLoaded || session.pageReady
        ? step(session, {})
        : failDocument(session)
  }
}
