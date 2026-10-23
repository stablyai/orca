// Why 15 minutes: it bounds one remote install step and a concurrent install's wait for the
// install lock, and must stay below the 20-minute stale-lock threshold (remote-install-lock.ts).
export const REMOTE_INSTALL_TIMEOUT_MS = 15 * 60_000
