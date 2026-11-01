/** Bumped only for a breaking change; within a version, fields and capabilities are only added. */
export const CONNECTOR_CONTRACT_VERSION = 1

export const CONNECTOR_LIMITS = {
  initialPollHoldMs: 50_000,
  // The machine abandons a held poll after this; the cloud holds below it and below the token expiry.
  pollTimeoutMs: 70_000,
  maxDeliveriesPerPoll: 20,
  deliveryTtlMs: 5 * 60 * 1000,
  // A handed-out delivery not yet received goes out again, same id, after this.
  leaseMs: 30_000,
  // A leased delivery that was never received expires this long after expiresAt.
  leasedExpiryGraceMs: 30_000,
  // The machine refuses a delivery with less than this left before its deadline.
  minDeadlineLeftMs: 10_000,
  maxLastAssistantMessageBytes: 8 * 1024,
  // The cloud refuses a larger request body with 413.
  maxRequestBytes: 256 * 1024,
  // One event's JSON, so any single event fits in an events request.
  maxEventBytes: 192 * 1024,
  // A snapshot lists linked conversations active in the last 7 days, newest first, up to this many.
  maxSnapshotConversations: 200,
  snapshotActiveWindowMs: 7 * 24 * 60 * 60 * 1000,
  // A hello lists the most recently used projects, up to this many, and always fits maxRequestBytes.
  maxHelloProjects: 500,
  maxDisplayTextLength: 200
} as const
