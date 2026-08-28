const DEFAULT_KEEPALIVE_INTERVAL_MS = 15_000

// Why: test-only escape hatch so subprocess tests avoid the full 15 s window; bogus values fall back to the default.
function resolveKeepaliveIntervalMs(): number {
  const raw = process.env.ORCA_KEEPALIVE_INTERVAL_MS ?? process.env.ORCA_HEARTBEAT_INTERVAL_MS
  if (!raw) {
    return DEFAULT_KEEPALIVE_INTERVAL_MS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_KEEPALIVE_INTERVAL_MS
  }
  return parsed
}

export function startCheckKeepalive(deadlineMs: number | undefined): () => void {
  const startedAt = Date.now()
  const interval = setInterval(() => {
    const payload = {
      _keepalive: true,
      // Why: retain the old marker for scripts still filtering it while callers migrate to _keepalive.
      _heartbeat: true,
      elapsedMs: Date.now() - startedAt,
      deadlineMs: deadlineMs ?? null
    }
    process.stderr.write(`${JSON.stringify(payload)}\n`)
  }, resolveKeepaliveIntervalMs())
  if (typeof interval.unref === 'function') {
    interval.unref()
  }
  return () => clearInterval(interval)
}
