import type { MobileWebShellSession } from './mobile-web-shell-session-contract'

/**
 * Whether the shell should take the device Back key off the navigator for this session.
 *
 * Gated on `ready` and not on the claim alone, and that is the whole point: a page fault, a wall, a
 * retry and a failed update each take the state out of `ready` without a frame from the page, and a
 * claim read without this would survive every one of them — the key would then be held for a
 * document that is no longer on screen, which is a Back press that does nothing at all.
 */
export function shellPageBackClaimed(
  session: Pick<MobileWebShellSession, 'state' | 'pageBackClaimed'>
): boolean {
  return session.state.kind === 'ready' && session.pageBackClaimed
}
