export const PUSH_LIMITS = {
  titleMaxChars: 80,
  bodyMaxChars: 180,
  maxRegistrationIdsPerSend: 20,
  // A host pairs phones, not a fleet. The cap bounds what one session can write
  // through a caller-chosen deviceId.
  maxDevicesPerHost: 64,
  // The list response is bounded well above the per-host cap so the query LIMIT
  // and the response schema can never disagree.
  maxDevicesPerListResponse: 1024,
  maxHttpBodyBytes: 16 * 1024,
  hostSendsPerRollingHour: 60,
  registrationSendsPerRollingDay: 200,
  coalesceWindowMs: 3_000,
  challengeTtlMs: 10_000,
  // Covers routine NTP drift without extending the signed challenge window.
  clockSkewToleranceMs: 30_000,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  // One hour past the widest quota window so a rolling day never reads a pruned row.
  sendLogRetentionMs: 25 * 60 * 60 * 1000,
  notificationTtlSeconds: 4 * 60 * 60,
  apnsCollapseIdMaxBytes: 64,
  // A host row outlives its devices only long enough to survive a phone swap.
  hostRetentionMs: 30 * 24 * 60 * 60 * 1000,
  // The challenge and session routes are the only unauthenticated writes, so
  // they are capped per client IP before any key material is generated.
  unauthenticatedRequestsPerMinutePerIp: 30
} as const

export const PUSH_DEFAULTS = {
  apnsTopic: 'com.stably.orca.mobile',
  fcmProjectId: 'onorca-cloud',
  androidChannelId: 'orca-desktop',
  gatewayUrl: 'https://push.onorca.dev'
} as const

export const PUSH_HOST_FINGERPRINT_LENGTH = 16
