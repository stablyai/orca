// A phone reopens its splice after a close, the way the app does, instead of failing the run.
// Without retries (retryMaxMs 0) the first failure still rejects, as before.
export async function holdRelayLoadSplice({
  open,
  retryMaxMs,
  stopping,
  onFailure = () => undefined,
  delay,
  random = Math.random
}) {
  if (retryMaxMs <= 0) return await open()
  while (!stopping()) {
    try {
      return await open()
    } catch (error) {
      if (stopping()) return undefined
      onFailure(relayLoadSpliceFailureReason(error))
      await delay(Math.ceil(random() * retryMaxMs))
    }
  }
  return undefined
}

// Stable buckets for the report: close codes and HTTP statuses, never ids.
export function relayLoadSpliceFailureReason(error) {
  const message = error instanceof Error ? error.message : String(error)
  const closed = /^splice closed: (\d+)/.exec(message)
  if (closed) return `closed_${closed[1]}`
  const response = /^Unexpected server response: (\d{3})/.exec(message)
  if (response) return `http_${response[1]}`
  if (message.startsWith('active control required')) return 'no_active_control'
  return 'other'
}

export function relayLoadSpliceReopenSummary(gapsMs, awaiting) {
  const sorted = [...gapsMs].sort((left, right) => left - right)
  const at = (quantile) =>
    sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]
  return { reopened: sorted.length, awaiting, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: sorted.at(-1) ?? null }
}
