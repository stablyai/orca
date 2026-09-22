export const PUSH_LIMITS = {
  titleMaxChars: 80,
  bodyMaxChars: 180,
  maxRegistrationIdsPerSend: 20,
  // A host pairs phones, not a fleet. The cap bounds what one session can write
  // through a caller-chosen deviceId.
  maxDevicesPerHost: 64,
  maxHttpBodyBytes: 16 * 1024,
  hostEventsPerWindow: 300,
  eventQuotaWindowMs: 15 * 60 * 1000,
  challengeTtlMs: 10_000,
  // Covers routine NTP drift without extending the signed challenge window.
  clockSkewToleranceMs: 30_000,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  notificationTtlSeconds: 5 * 60,
  // The challenge and session routes are the only unauthenticated writes, so
  // they are capped per client IP before any key material is generated.
  unauthenticatedRequestsPerMinutePerIp: 30,
  authenticatedRequestsPerMinutePerIp: 6_000,
  authenticatedRequestsPerMinutePerHost: 600
} as const

export const PUSH_DEFAULTS = {
  apnsTopic: 'com.stably.orca.mobile',
  androidChannelId: 'orca-desktop'
} as const

export const PUSH_HOST_FINGERPRINT_LENGTH = 16
