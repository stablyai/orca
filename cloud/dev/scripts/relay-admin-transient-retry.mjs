// A single transient 5xx (load-balancer warm-up behind a fresh instance) must not fail a
// deploy step. 4xx is never retried: auth and generation-mismatch answers are final.
const TRANSIENT_STATUSES = [500, 502, 503, 504]
const RETRY_DELAY_MS = 2_000
const REQUEST_TIMEOUT_MS = 30_000

export function isTransientAdminStatus(status) {
  return TRANSIENT_STATUSES.includes(status)
}

// Each attempt gets its own timeout budget, so a reused signal cannot abort the retry.
export async function fetchAdminOnceMore(fetchImpl, url, init, overrides = {}) {
  const wait = overrides.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = overrides.timeoutMs ?? REQUEST_TIMEOUT_MS
  const retryDelayMs = overrides.retryDelayMs ?? RETRY_DELAY_MS
  const attempt = async () =>
    await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  let response
  try {
    response = await attempt()
  } catch {
    await wait(retryDelayMs)
    return await attempt()
  }
  if (!isTransientAdminStatus(response.status)) return response
  await response.arrayBuffer?.().catch(() => undefined)
  await wait(retryDelayMs)
  return await attempt()
}
