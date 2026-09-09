const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 5 * 60_000

// Why: recover brief failures quickly without turning a sustained outage into auth/director load.
export function relayRetryDelayMs(attempt: number, random: () => number): number {
  const exponent = Math.min(attempt, Math.ceil(Math.log2(RETRY_MAX_MS / RETRY_BASE_MS)))
  const capMs = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent)
  return Math.floor(random() * (capMs + 1))
}
