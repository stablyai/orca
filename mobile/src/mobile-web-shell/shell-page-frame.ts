import type { MobileWebShellSession } from './mobile-web-shell-session-contract'

// Keep the shell cover over a mounted but unpainted WebView so cached boot cannot expose a blank surface.
export type ShellPageFrame = 'pending' | 'unpainted' | 'painted'

export function shellPageFrame(
  session: Pick<MobileWebShellSession, 'state' | 'pagePainted'>
): ShellPageFrame {
  if (session.state.kind !== 'ready') {
    return 'pending'
  }
  return session.pagePainted ? 'painted' : 'unpainted'
}
