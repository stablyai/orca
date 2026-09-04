export const PUSH_LIMITS = {
  titleMaxChars: 80,
  bodyMaxChars: 180,
  maxRegistrationIdsPerSend: 20,
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
  apnsCollapseIdMaxBytes: 64
} as const

export const PUSH_DEFAULTS = {
  apnsTopic: 'com.stably.orca.mobile',
  fcmProjectId: 'onorca-cloud',
  androidChannelId: 'orca-desktop',
  gatewayUrl: 'https://push.onorca.dev'
} as const

export const PUSH_HOST_FINGERPRINT_LENGTH = 16
