import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import { BRIDGE_SAFE_AREA_ACCEPT } from './bridge/bridge-safe-area-insets'
import { BRIDGE_KEYBOARD_INSET_ACCEPT } from './bridge/bridge-keyboard-inset'
import type {
  MobileWebShellSession,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'

/** Everything one document told the shell about itself, which the next one has to say again. */
export const CLEAR_PAGE_DOCUMENT_STATE = {
  pageReady: false,
  pageReportsPaint: false,
  pagePainted: false,
  pageBackClaimed: false,
  pageOwnsSafeArea: false,
  pageReadsKeyboardInset: false
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
  session: Pick<MobileWebShellSession, 'state' | 'pageReportsPaint'>,
  event: PageDocumentEvent
): Partial<MobileWebShellSession> {
  if (session.state.kind !== 'ready') {
    return {}
  }
  if (event.type === 'page-back-claim') {
    return { pageBackClaimed: event.claimed }
  }
  if (event.type === 'page-ready') {
    // Re-read on every ask rather than latched: a document that reloads inside this mount asks
    // again, and it is the newest ask that says whether a paint report is coming. The key goes with
    // it: the host drops the claim on the same `ready`, so a page that still holds one re-claims.
    return {
      pageReady: true,
      pageReportsPaint: event.reports.includes(BRIDGE_PAGE_PAINTED),
      pageBackClaimed: false,
      pageOwnsSafeArea: event.accepts.includes(BRIDGE_SAFE_AREA_ACCEPT),
      pageReadsKeyboardInset: event.accepts.includes(BRIDGE_KEYBOARD_INSET_ACCEPT)
    }
  }
  // Kept off a page that never said it would report: acting on an unasked-for frame would make
  // the wait depend on a name arriving instead of on a claim the page made.
  return session.pageReportsPaint ? { pagePainted: true } : {}
}

/** Whether the shell may draw the view edge-to-edge: gated on `ready` like the Back claim, so a
 *  declaration never outlives the document on screen. */
export function shellPageOwnsSafeArea(
  session: Pick<MobileWebShellSession, 'state' | 'pageOwnsSafeArea'>
): boolean {
  return session.state.kind === 'ready' && session.pageOwnsSafeArea
}

/** Whether the shell may let the keyboard cover the view, gated on `ready` the same way. */
export function shellPageReadsKeyboardInset(
  session: Pick<MobileWebShellSession, 'state' | 'pageReadsKeyboardInset'>
): boolean {
  return session.state.kind === 'ready' && session.pageReadsKeyboardInset
}
