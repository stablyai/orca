export function wslDistroListRetryDelayMs(emptyStreak: number): number {
  // Provisioning is one-time, so bounded backoff avoids polling docker-desktop-only hosts.
  return Math.min(15_000 * 2 ** (emptyStreak - 1), 5 * 60_000)
}
