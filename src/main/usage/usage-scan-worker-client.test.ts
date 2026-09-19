import { readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import {
  MAX_CONSECUTIVE_DEATHS,
  USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS,
  UsageScanWorkerClient,
  scanCodexUsageOnWorker
} from './usage-scan-worker-client'
import { USAGE_SCAN_WORKER_ENTRY_FILENAME } from './usage-scan-worker-spawn'
import type {
  UsageScanWorkerRequest,
  UsageScanWorkerRequestBody
} from './usage-scan-worker-protocol'

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: FakeWorker implements the on/off/postMessage/terminate surface LazyWorkerThreadHost uses, and nothing here touches the rest of Worker.
  return new UsageScanWorkerClient({ workerFactory: factory as never, log: () => {} })
}

const CODEX_BODY: UsageScanWorkerRequestBody = {
  providerId: 'codex',
  worktrees: [],
  previous: []
}

describe('UsageScanWorkerClient', () => {
  it('routes a scan to the worker and hands back that provider’s projection', async () => {
    const worker = new FakeWorker()
    const client = createClient(() => worker)

    const pending = scanCodexUsageOnWorker((body) => client.scan(body), [], [])
    await vi.waitFor(() => expect(worker.postedRequests).toHaveLength(1))
    expect(worker.postedRequests[0]?.providerId).toBe('codex')
    worker.emit('message', {
      id: worker.lastId(),
      ok: true,
      value: {
        providerId: 'codex',
        source: [{ path: 'a.jsonl' }],
        sessions: [],
        dailyAggregates: []
      }
    })

    await expect(pending).resolves.toMatchObject({ source: [{ path: 'a.jsonl' }] })
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
      worker.emit('message', {
        id: worker.lastId(),
        ok: true,
        value: {
          providerId: 'codex',
          source: [{ path: 'a.jsonl' }],
          sessions: [],
          dailyAggregates: []
        }
      })

      await expect(pending).resolves.toMatchObject({ source: [{ path: 'a.jsonl' }] })
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

    const pending = scanCodexUsageOnWorker((body) => client.scan(body), [], [])
    await vi.waitFor(() => expect(worker.postedRequests).toHaveLength(1))
    worker.emit('message', {
      id: worker.lastId(),
      ok: true,
      value: { providerId: 'claude', source: [], sessions: [], dailyAggregates: [] }
    })

    await expect(pending).rejects.toThrow(/answered for claude/)
  })
})

// Why: the packaged branch never runs in dev or e2e (both take the __dirname
// path), so it is pinned here at the path-construction level.
describe('usage scan worker entry path', () => {
  it('resolves a packaged build under resourcesPath/app.asar/out/main', () => {
    const resourcesPath = join(sep, 'Applications', 'Orca.app', 'Contents', 'Resources')

    const resolved = resolveWorkerThreadEntryPath(
      { isPackaged: true, resourcesPath, moduleDir: join(sep, 'unpackaged', 'out', 'main') },
      USAGE_SCAN_WORKER_ENTRY_FILENAME
    )

    expect(resolved.slice(resourcesPath.length + 1).split(sep)).toEqual([
      'app.asar',
      'out',
      'main',
      USAGE_SCAN_WORKER_ENTRY_FILENAME
    ])
  })

  // A rename in the build config would leave both branches pointing at a file
  // that is never emitted, and only the packaged one fails silently.
  it('names the entry the main build actually emits', () => {
    const config = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'electron.vite.config.ts'),
      'utf8'
    )

    expect(USAGE_SCAN_WORKER_ENTRY_FILENAME).toBe('usage-scan-worker-entry.js')
    expect(config).toContain("'usage-scan-worker-entry': resolve(")
  })
})
