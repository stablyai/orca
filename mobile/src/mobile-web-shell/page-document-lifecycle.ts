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

export function reducePageDocumentLifecycle(
  session: MobileWebShellSession,
  event: PageDocumentLifecycleEvent,
  failDocument: (session: MobileWebShellSession) => MobileWebShellStep
): MobileWebShellStep {
  switch (event.type) {
    case 'remounted':
      // Remount the same verified bytes with a fresh session; reset document facts and advance flow so retired deadlines cannot expire onto the replacement.
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
      // Reset paint/claims and advance flow: the new document inherits neither proof of rendering nor the previous document’s deadlines.
      return session.state.kind === 'ready'
        ? step(session, { ...CLEAR_PAGE_DOCUMENT_STATE, flow: session.flow + 1 }, [
            AWAIT_DOCUMENT_LOAD
          ])
        : step(session, {})
    case 'document-loaded':
      // Ready and document-loaded can arrive in either order; arm the ready wait only if still needed.
      if (session.state.kind !== 'ready') {
        return step(session, {})
      }
      return session.pageReady
        ? step(session, { documentLoaded: true })
        : step(session, { documentLoaded: true }, [{ kind: 'await-page-ready' }])
    case 'page-ready-deadline':
      // Finished WebView load without page ready is still a startup failure.
      return session.pageReady ? step(session, {}) : failDocument(session)
    case 'document-load-deadline':
      // iOS 18 can cancel its own document without reporting load failure (#28626); bound the otherwise endless blank cover.
      return session.state.kind !== 'ready' || session.documentLoaded || session.pageReady
        ? step(session, {})
        : failDocument(session)
  }
}
