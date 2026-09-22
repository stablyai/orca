import type { MobileWebShellSession } from './mobile-web-shell-session-contract'

/**
 * How far the shell's own frame has to stay up.
 *
 * `pending` is every state before a generation is on screen, which the screen already paints for
 * itself. `unpainted` is the one that was missing: the view is mounted, the WebView draws nothing
 * until its document paints, and what shows through is the surface behind it with nothing on it —
 * for a cached generation, the whole of the page's boot. `painted` is the page's own word that it
 * has a frame, and the only thing that lifts the cover.
 */
export type ShellPageFrame = 'pending' | 'unpainted' | 'painted'

/**
 * Bounded by the page's declaration, never by a timer.
 *
 * A page that said it reports a paint is waited for, because it will answer. A page that said
 * nothing is one built before the report existed — the generation is served by a desktop that
 * updates on its own schedule — and the newest thing it will ever say is `ready`, so that is what
 * uncovers it. Waiting on a word that page cannot speak would hide a working workspace for the
 * life of the document, which is worse than the empty frame this replaces.
 */
export function shellPageFrame(
  session: Pick<MobileWebShellSession, 'state' | 'pageReady' | 'pageReportsPaint' | 'pagePainted'>
): ShellPageFrame {
  if (session.state.kind !== 'ready') {
    return 'pending'
  }
  if (session.pagePainted) {
    return 'painted'
  }
  return session.pageReportsPaint || !session.pageReady ? 'unpainted' : 'painted'
}
