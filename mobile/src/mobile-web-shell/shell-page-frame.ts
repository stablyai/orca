import type { MobileWebShellSession } from './mobile-web-shell-session-contract'

/**
 * How far the shell's own frame has to stay up. `unpainted` is the state that was missing: the
 * view is mounted and the WebView draws nothing until its document paints, so what shows is the
 * surface behind it with nothing on it, for the whole of a cached generation's boot.
 */
export type ShellPageFrame = 'pending' | 'unpainted' | 'painted'

/** Up until the page reports a frame of its own; every page the shell serves reports one. */
export function shellPageFrame(
  session: Pick<MobileWebShellSession, 'state' | 'pagePainted'>
): ShellPageFrame {
  if (session.state.kind !== 'ready') {
    return 'pending'
  }
  return session.pagePainted ? 'painted' : 'unpainted'
}
