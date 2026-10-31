import type { MobileWebShellSession } from './mobile-web-shell-session-contract'

// Gate claims on ready so faults/walls/retries cannot leave Back held by a document no longer on screen.
export function shellPageBackClaimed(
  session: Pick<MobileWebShellSession, 'state' | 'pageBackClaimed'>
): boolean {
  return session.state.kind === 'ready' && session.pageBackClaimed
}
