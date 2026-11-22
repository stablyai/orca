export type LoginSessionWatchTiming = {
  periodicProbeMs: number
  rejectionRecheckMs: number
  minimumRejectionSpanMs: number
  ptyExitDebounceMs: number
  clientActivityMinGapMs: number
  minProbeGapMs: number
}

export const DEFAULT_LOGIN_SESSION_WATCH_TIMING: LoginSessionWatchTiming = {
  periodicProbeMs: 120_000,
  rejectionRecheckMs: 10_000,
  // Separate logout from brief wake/PAM recovery failures.
  minimumRejectionSpanMs: 120_000,
  ptyExitDebounceMs: 2_000,
  // Reconnecting clients must not cause a PAM probe storm.
  clientActivityMinGapMs: 30_000,
  minProbeGapMs: 5_000
}
