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
  // Why: a full periodic window separates logout from short wake/PAM recovery bursts.
  minimumRejectionSpanMs: 120_000,
  ptyExitDebounceMs: 2_000,
  // Why: steady reconnects must not turn client hellos into a PAM probe storm.
  clientActivityMinGapMs: 30_000,
  minProbeGapMs: 5_000
}
