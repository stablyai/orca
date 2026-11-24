import type {
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'

export function step(
  session: MobileWebShellSession,
  patch: Partial<MobileWebShellSession>,
  effects: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  return { session: { ...session, ...patch }, effects }
}
