export const GAP_RECOVERY_POLICY = {
  minIntervalMs: 1_000,
  backoffMaxMs: 30_000,
  warnAfterAttempts: 5,
  captureTimeoutMs: 35_000,
  maxConcurrentCaptures: 8,
  catchUpPollMs: 50
} as const
