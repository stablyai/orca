import type { MobileWebShellSession } from './mobile-web-shell-session-contract'

/**
 * How far the shell's own frame has to stay up. `unpainted` is the state that was missing: the
 * view is mounted and the WebView draws nothing until its document paints, so what shows is the
 * surface behind it with nothing on it, for the whole of a cached generation's boot.
 */
export type ShellPageFrame = 'pending' | 'unpainted' | 'painted'

/**
 * Bounded by the page's declaration, never by a timer. A page that declared none is one served by
 * a desktop older than the report, and `ready` is the newest thing it will ever say: waiting on a
 * word it cannot speak would hide a working workspace for the life of the document.
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
