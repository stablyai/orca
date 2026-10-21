import type {
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'

/**
 * One transition, built in one place: the session the patch produces and the effects it owes.
 * Shared by the reducer and by the cached-generation opener beside it, so a step means the same
 * thing wherever it is taken.
 */
export function step(
  session: MobileWebShellSession,
  patch: Partial<MobileWebShellSession>,
  effects: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  return { session: { ...session, ...patch }, effects }
}
