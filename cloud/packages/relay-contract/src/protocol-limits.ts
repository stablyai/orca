export const RELAY_PROTOCOL_LIMITS = {
  firstFrameDeadlineMs: 2_000,
  maxHttpBodyBytes: 4 * 1024,
  // Why: the splice is an opaque E2EE stream; the desktop's worktree catalog
  // response already exceeds 1MiB on large workspaces (~775KiB at 415
  // worktrees, growing), and an oversized frame kills the session on every
  // reconnect. 8MiB buys years of headroom; catalog pagination is the
  // long-term fix on the desktop side.
  maxFrameBytes: 8 * 1024 * 1024,
  maxConnectionsPerHost: 8,
  idleTimeoutMs: 10 * 60 * 1000,
  inviteTtlMs: 10 * 60 * 1000,
  inviteMaxAttempts: 5,
  inviteReservationLeaseMs: 15 * 1000,
  inviteAttemptCooldownMs: 2 * 1000,
  hostAttachDeadlineMs: 10 * 1000,
  resumeConfirmationDeadlineMs: 30 * 1000,
  resumeTtlMs: 30 * 24 * 60 * 60 * 1000,
  relayTokenTtlMs: 5 * 60 * 1000,
  expiredAuthExistingSpliceGraceMs: 60 * 1000,
  controlPingIntervalMs: 15 * 1000,
  controlSilenceTimeoutMs: 75 * 1000
} as const
