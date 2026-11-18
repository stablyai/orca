// Bound install steps and lock waits below the 20-minute stale-lock threshold; only local WSL installs wait through to takeover.
export const REMOTE_INSTALL_TIMEOUT_MS = 15 * 60_000
