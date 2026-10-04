import type {
  MobileWebShellSession,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'

/** Everything one document told the shell about itself, which the next one has to say again. */
export const CLEAR_PAGE_DOCUMENT_STATE = {
  pageReady: false,
  pagePainted: false,
  pageBackClaimed: false
} as const

/** The three things a document reports about itself, as the reducer receives them. */
export type PageDocumentEvent = Extract<
  MobileWebShellSessionEvent,
  { type: 'page-ready' } | { type: 'page-painted' } | { type: 'page-back-claim' }
>

/**
 * What one of those events leaves on the session. Nothing outside `ready` changes anything: the
 * view exists only under the generation on screen.
 */
export function pageDocumentStatePatch(
  session: Pick<MobileWebShellSession, 'state'>,
  event: PageDocumentEvent
): Partial<MobileWebShellSession> {
  if (session.state.kind !== 'ready') {
    return {}
  }
  if (event.type === 'page-back-claim') {
    return { pageBackClaimed: event.claimed }
  }
  if (event.type === 'page-ready') {
    // The host drops the claim on the same `ready`, so a page that still holds one re-claims.
    return { pageReady: true, pageBackClaimed: false }
  }
  return { pagePainted: true }
}
