export const PROVIDER_STDIN_END_GRACE_MS = 1_000
export const PROVIDER_SIGTERM_GRACE_MS = 3_000
export const PROVIDER_GROUP_REAP_TIMEOUT_MS = 1_500
export const PROVIDER_OUTPUT_DRAIN_TIMEOUT_MS = 1_000
// Saved owners from older versions are supervisors; allow their entire ladder to finish.
export const PROVIDER_SUPERVISOR_MAX_STOP_MS =
  PROVIDER_STDIN_END_GRACE_MS + PROVIDER_SIGTERM_GRACE_MS + PROVIDER_GROUP_REAP_TIMEOUT_MS
