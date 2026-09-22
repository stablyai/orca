const DEFAULT_TIMEOUT_MS = 8_000
const DEFAULT_POLL_MS = 100

export async function createRelayLoadReaderEvidence(origins, dependencies) {
  const distinctOrigins = [...new Set(origins)].sort()
  const baselines = new Map(await Promise.all(distinctOrigins.map(async (origin) => [
    origin,
    await dependencies.readQueuedBytes(origin)
  ])))
  const peaks = new Map(baselines)
  const pending = new Map()
  const now = dependencies.now ?? Date.now
  const delay = dependencies.delay
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = dependencies.pollMs ?? DEFAULT_POLL_MS

  const observe = async ({ cellOrigin }) => {
    if (!baselines.has(cellOrigin)) throw new Error('reader origin lacks a run baseline')
    if (peaks.get(cellOrigin) > baselines.get(cellOrigin)) return
    const current = pending.get(cellOrigin)
    if (current) return await current
    const proof = (async () => {
      const baseline = baselines.get(cellOrigin)
      const deadline = now() + timeoutMs
      for (;;) {
        const queuedBytes = await dependencies.readQueuedBytes(cellOrigin)
        peaks.set(cellOrigin, Math.max(peaks.get(cellOrigin), queuedBytes))
        if (queuedBytes > baseline) return
        if (now() >= deadline) {
          throw new Error('reader stream produced no causal Relay queued-byte increase')
        }
        await delay(pollMs)
      }
    })()
    pending.set(cellOrigin, proof)
    try {
      await proof
    } finally {
      pending.delete(cellOrigin)
    }
  }

  const snapshot = () => distinctOrigins.map((origin) => ({
    origin,
    baselineBytes: baselines.get(origin),
    peakBytes: peaks.get(origin),
    increaseBytes: peaks.get(origin) - baselines.get(origin)
  }))

  return { observe, snapshot }
}
