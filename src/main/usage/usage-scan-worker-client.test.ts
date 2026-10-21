import { describe, expect, it, vi } from 'vitest'
import {
  MAX_CONSECUTIVE_DEATHS,
  USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS,
  UsageScanWorkerClient,
  scanCodexUsageOnWorker
} from './usage-scan-worker-client'
import type { UsageScanWorkerRequest, UsageScanWorkerScanBody } from './usage-scan-worker-protocol'
import type { UsageSourceCacheRef } from './usage-source-cache-file'

// A worker_threads stand-in the tests drive directly: it records posted requests
// and lets a test emit message/error/exit without a built worker bundle.
class FakeWorker {
  postedRequests: UsageScanWorkerRequest[] = []
  private listeners = new Map<string, Set<(arg?: unknown) => void>>()

  on(event: string, listener: (arg?: unknown) => void): this {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return this
  }

  off(event: string, listener: (arg?: unknown) => void): this {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  unref(): void {}

  async terminate(): Promise<number> {
    return 1
  }

  postMessage(request: UsageScanWorkerRequest): void {
    this.postedRequests.push(request)
  }

  emit(event: string, arg?: unknown): void {
    // Copy first: the client removes its listeners synchronously during a fault.
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }

  lastId(): number {
    return this.postedRequests.at(-1)?.id ?? -1
  }
}

function createClient(factory: () => FakeWorker): UsageScanWorkerClient {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeWorker implements the transport lifecycle; absent threadId skips optional owner cleanup.
  return new UsageScanWorkerClient({ workerFactory: factory as never, log: () => {} })
}

const SOURCE_CACHE: UsageSourceCacheRef = {
  path: '/tmp/orca-codex-usage-sources.json',
  schemaVersion: 6,
  worktreeFingerprint: '[]',
  reuse: true
}

const CODEX_BODY: UsageScanWorkerScanBody = {
  operation: 'scan',
  providerId: 'codex',
  worktrees: [],
  sourceCache: SOURCE_CACHE
}

const CODEX_VALUE = {
  operation: 'scan',
  providerId: 'codex',
  sessions: [{ sessionId: 'session-1' }],
  dailyAggregates: []
}

describe('UsageScanWorkerClient', () => {
  it('routes a scan to the worker and hands back that provider’s projection', async () => {
    const worker = new FakeWorker()
    const client = createClient(() => worker)

    const pending = scanCodexUsageOnWorker((body) => client.scan(body), [], SOURCE_CACHE)
    await vi.waitFor(() => expect(worker.postedRequests).toHaveLength(1))
    // The request names where the worker keeps the per-source cache instead of carrying it.
    expect(worker.postedRequests[0]).toMatchObject({
      operation: 'scan',
      providerId: 'codex',
      sourceCache: SOURCE_CACHE
    })
    worker.emit('message', { id: worker.lastId(), ok: true, value: CODEX_VALUE })

    await expect(pending).resolves.toEqual({
      sessions: [{ sessionId: 'session-1' }],
      dailyAggregates: []
    })
  })

  it('routes a cache split to the worker and hands back the report text', async () => {
    const worker = new FakeWorker()
    const client = createClient(() => worker)

    const pending = client.splitCacheFile({
      cacheFile: '/tmp/usage.json',
      sourceKey: 'processedFiles'
    })
    await vi.waitFor(() => expect(worker.postedRequests).toHaveLength(1))
    expect(worker.postedRequests[0]).toMatchObject({
      operation: 'splitCacheFile',
      cacheFile: '/tmp/usage.json',
      sourceKey: 'processedFiles'
    })
    worker.emit('message', {
      id: worker.lastId(),
      ok: true,
      value: { operation: 'splitCacheFile', reportText: '{}', migrated: true }
    })

    await expect(pending).resolves.toEqual({ reportText: '{}', migrated: true })
  })

  it('keeps worker verification attached to the exact returned report text', async () => {
    const worker = new FakeWorker()
    const client = createClient(() => worker)
    const pending = client.splitCacheFile({
      cacheFile: '/tmp/usage.json',
      sourceKey: 'processedFiles',
      providerId: 'claude'
    })
    await vi.waitFor(() => expect(worker.postedRequests).toHaveLength(1))
    const reportText = '{"usageIntegrity":"verified-by-worker","schemaVersion":7}'
    worker.emit('message', {
      id: worker.lastId(),
      ok: true,
      value: {
        operation: 'splitCacheFile',
        reportText,
        migrated: false,
        reportIntegrityVerified: true
      }
    })

    await expect(pending).resolves.toEqual({
      reportText,
      migrated: false,
      reportIntegrityVerified: true
    })
  })

  it('fails closed instead of scanning on the calling thread when spawn fails', async () => {
    const client = createClient(() => {
      throw new Error('no thread available')
    })

    // The rejection is what the store turns into `lastScanError`, keeping the
    // previous projection rather than publishing an empty one.
    await expect(client.scan(CODEX_BODY)).rejects.toThrow(/spawn failed/)
  })

  it('rejects a scan whose worker goes silent', async () => {
    vi.useFakeTimers()
    try {
      const client = createClient(() => new FakeWorker())
      const pending = client.scan(CODEX_BODY)
      const assertion = expect(pending).rejects.toThrow(/no progress/)
      await vi.advanceTimersByTimeAsync(USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS + 1)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps waiting on a scan that is slow but still reporting progress', async () => {
    vi.useFakeTimers()
    try {
      const worker = new FakeWorker()
      const client = createClient(() => worker)
      const pending = client.scan(CODEX_BODY)
      // Posted synchronously by dispatch; vi.waitFor would advance the fake clock.
      expect(worker.postedRequests).toHaveLength(1)

      // Four windows of wall clock, each broken by a progress message just
      // before the deadline: the old wall-clock budget died in the first one.
      for (let window = 1; window <= 4; window++) {
        await vi.advanceTimersByTimeAsync(USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS - 1)
        worker.emit('message', { id: worker.lastId(), filesScanned: window * 100 })
      }
      await vi.advanceTimersByTimeAsync(USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS - 1)
      worker.emit('message', { id: worker.lastId(), ok: true, value: CODEX_VALUE })

      await expect(pending).resolves.toMatchObject({ sessions: [{ sessionId: 'session-1' }] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('still kills a worker that stops reporting progress mid-scan', async () => {
    vi.useFakeTimers()
    try {
      const worker = new FakeWorker()
      const client = createClient(() => worker)
      const pending = client.scan(CODEX_BODY)
      expect(worker.postedRequests).toHaveLength(1)
      const assertion = expect(pending).rejects.toThrow(/no progress/)

      await vi.advanceTimersByTimeAsync(USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS - 1)
      worker.emit('message', { id: worker.lastId(), filesScanned: 100 })
      await vi.advanceTimersByTimeAsync(USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS + 1)

      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a worker-side scan failure as an error rather than an empty result', async () => {
    const worker = new FakeWorker()
    const client = createClient(() => worker)

    const pending = client.scan(CODEX_BODY)
    await vi.waitFor(() => expect(worker.postedRequests).toHaveLength(1))
    worker.emit('message', { id: worker.lastId(), ok: false, error: 'history unreadable' })

    await expect(pending).rejects.toThrow('history unreadable')
  })

  it('stops respawning after the consecutive-death cap', async () => {
    const workers: FakeWorker[] = []
    const client = createClient(() => {
      const worker = new FakeWorker()
      workers.push(worker)
      return worker
    })

    // One more call than the cap, so the last one must be drained rather than
    // handed to a fourth worker.
    const pending = Array.from({ length: MAX_CONSECUTIVE_DEATHS + 1 }, () =>
      client.scan(CODEX_BODY)
    )
    const settled = Promise.allSettled(pending)
    for (let attempt = 0; attempt < MAX_CONSECUTIVE_DEATHS; attempt++) {
      await vi.waitFor(() => expect(workers).toHaveLength(attempt + 1))
      workers[attempt]?.emit('error', new Error(`crash ${attempt}`))
    }

    const results = await settled
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(workers.length).toBeLessThanOrEqual(MAX_CONSECUTIVE_DEATHS)
  })

  it('rejects a response that answers for a different provider', async () => {
    const worker = new FakeWorker()
    const client = createClient(() => worker)

    const pending = scanCodexUsageOnWorker((body) => client.scan(body), [], SOURCE_CACHE)
    await vi.waitFor(() => expect(worker.postedRequests).toHaveLength(1))
    worker.emit('message', {
      id: worker.lastId(),
      ok: true,
      value: { operation: 'scan', providerId: 'claude', sessions: [], dailyAggregates: [] }
    })

    await expect(pending).rejects.toThrow(/answered for claude/)
  })
})
