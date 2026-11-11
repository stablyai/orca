import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UsageScanWorkerClient,
  UsageScanWorkerUnavailableError,
  USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS
} from './scan-worker/usage-scan-worker-client'
import type {
  UsageScanWorkerProviderId,
  UsageScanWorkerRequest,
  UsageScanWorkerScanBody,
  UsageScanWorkerValue
} from './scan-worker/usage-scan-worker-protocol'

class ScanWorker extends EventEmitter {
  posted: UsageScanWorkerRequest[] = []
  exit: Promise<number> = Promise.resolve(1)
  terminate = vi.fn(() => this.exit)
  unref(): void {}

  postMessage(request: UsageScanWorkerRequest): void {
    this.posted.push(request)
  }

  complete(index: number): void {
    const request = this.posted[index]
    const value: UsageScanWorkerValue =
      request.operation === 'scan'
        ? { operation: 'scan', providerId: request.providerId, sessions: [], dailyAggregates: [] }
        : { operation: 'splitCacheFile', reportText: 'saved report', migrated: false }
    this.emit('message', { id: request.id, ok: true, value })
  }
}

function body(providerId: UsageScanWorkerProviderId, population = 1): UsageScanWorkerScanBody {
  return {
    operation: 'scan',
    providerId,
    worktrees: Array.from({ length: population }, (_, i) => ({
      repoId: 'repo',
      worktreeId: `tree-${i}`,
      displayName: `tree-${i}`,
      path: `/tree-${i}`
    })),
    sourceCache: {
      path: `/${providerId}-sources.json`,
      schemaVersion: 1,
      worktreeFingerprint: '[]',
      reuse: true
    }
  }
}

const clients: UsageScanWorkerClient[] = []
function fixture(): { client: UsageScanWorkerClient; workers: ScanWorker[] } {
  const workers: ScanWorker[] = []
  const client = new UsageScanWorkerClient({
    workerFactory: () => {
      const worker = new ScanWorker()
      workers.push(worker)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture implements every Worker member the host and transport use; no native Worker API is reached.
      return worker as unknown as Worker
    },
    log: () => {}
  })
  clients.push(client)
  return { client, workers }
}

beforeEach(() => vi.useFakeTimers())
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose().catch(() => {})))
  vi.useRealTimers()
})

describe('usage scan scheduling through the production client', () => {
  it.each([100, 1000])(
    'admits only four providers at %i worktrees and routes unordered replies',
    async (population) => {
      const { client, workers } = fixture()
      const calls = [
        client.scan(body('claude', population)),
        client.scan(body('codex', population)),
        client.scan(body('opencode', population)),
        client.scan(body('muse', population))
      ]
      const worker = workers[0]
      expect(worker.posted.map((request) => request.providerId)).toEqual([
        'claude',
        'codex',
        'opencode',
        'muse'
      ])
      worker.emit('message', { id: worker.posted[1].id, filesScanned: 1 })
      for (const index of [2, 0, 3, 1]) {
        worker.complete(index)
      }
      expect(await Promise.all(calls)).toEqual([
        { operation: 'scan', providerId: 'claude', sessions: [], dailyAggregates: [] },
        { operation: 'scan', providerId: 'codex', sessions: [], dailyAggregates: [] },
        { operation: 'scan', providerId: 'opencode', sessions: [], dailyAggregates: [] },
        { operation: 'scan', providerId: 'muse', sessions: [], dailyAggregates: [] }
      ])
    }
  )

  it('keeps same-provider FIFO and makes a split an exclusive barrier without overtaking', async () => {
    const { client, workers } = fixture()
    const first = client.scan(body('claude'))
    const second = client.scan(body('claude'))
    const codex = client.scan(body('codex'))
    const split = client.splitCacheFile({ cacheFile: '/claude.json', sourceKey: 'processedFiles' })
    const muse = client.scan(body('muse'))
    const worker = workers[0]
    expect(worker.posted.map((request) => request.providerId)).toEqual(['claude', 'codex'])
    worker.complete(0)
    expect(worker.posted.map((request) => request.providerId)).toEqual([
      'claude',
      'codex',
      'claude'
    ])
    worker.complete(2)
    expect(worker.posted).toHaveLength(3)
    worker.complete(1)
    expect(worker.posted[3].operation).toBe('splitCacheFile')
    expect(worker.posted).toHaveLength(4)
    worker.complete(3)
    expect(worker.posted[4].providerId).toBe('muse')
    worker.complete(4)
    await Promise.all([first, second, codex, muse])
    expect(await split).toEqual({ reportText: 'saved report', migrated: false })
  })

  it('settles every posted call on one fault, parks only unposted work, and never replays', async () => {
    const { client, workers } = fixture()
    const posted = [
      client.scan(body('claude')),
      client.scan(body('codex')),
      client.scan(body('muse'))
    ].map((promise) => promise.catch((error: unknown) => error))
    const pending = client.scan(body('claude'))
    const old = workers[0]
    let proveExit!: (code: number) => void
    old.exit = new Promise((resolve) => {
      proveExit = resolve
    })
    const failure = new Error('worker crashed')
    old.emit('error', failure)
    expect(await Promise.all(posted)).toEqual([failure, failure, failure])
    expect(old.terminate).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS + 1)
    expect(workers).toHaveLength(1)
    proveExit(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(workers).toHaveLength(2)
    expect(workers[1].posted.map((request) => request.providerId)).toEqual(['claude'])
    old.complete(0)
    workers[1].complete(0)
    expect(await pending).toEqual({
      operation: 'scan',
      providerId: 'claude',
      sessions: [],
      dailyAggregates: []
    })
  })

  it('times each dispatched ID independently, ignoring other-provider and unknown progress', async () => {
    const { client, workers } = fixture()
    const claude = client.scan(body('claude')).catch((error: unknown) => error)
    const codex = client.scan(body('codex')).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS / 2)
    workers[0].emit('message', { id: workers[0].posted[1].id, filesScanned: 1 })
    workers[0].emit('message', { id: 999, filesScanned: 1 })
    await vi.advanceTimersByTimeAsync(USAGE_SCAN_NO_PROGRESS_TIMEOUT_MS / 2 + 1)
    expect(await claude).toEqual(new Error('Usage scan worker reported no progress for 600000ms'))
    expect(await codex).toEqual(new Error('Usage scan worker reported no progress for 600000ms'))
    expect(workers[0].terminate).toHaveBeenCalledTimes(1)
  })

  it('counts a shared death once and caps consecutive worker deaths in one queued burst', async () => {
    const { client, workers } = fixture()
    const calls = [
      client.scan(body('claude')),
      client.scan(body('codex')),
      client.scan(body('opencode')),
      client.scan(body('muse')),
      client.scan(body('claude')),
      client.scan(body('claude')),
      client.scan(body('claude'))
    ].map((promise) => promise.catch((error: unknown) => error))
    workers[0].emit('error', new Error('fault one'))
    await vi.advanceTimersByTimeAsync(0)
    expect(workers).toHaveLength(2)
    workers[1].emit('error', new Error('fault two'))
    await vi.advanceTimersByTimeAsync(0)
    expect(workers).toHaveLength(3)
    workers[2].emit('error', new Error('fault three'))
    const results = await Promise.all(calls)
    expect(results).toEqual([
      new Error('fault one'),
      new Error('fault one'),
      new Error('fault one'),
      new Error('fault one'),
      new Error('fault two'),
      new Error('fault three'),
      new Error('Usage scan worker crashed repeatedly (fault three)')
    ])
    expect(workers).toHaveLength(3)
  })

  it('keeps a request-level error local while the other provider completes', async () => {
    const { client, workers } = fixture()
    const claude = client.scan(body('claude')).catch((error: unknown) => error)
    const codex = client.scan(body('codex'))
    workers[0].emit('message', { id: workers[0].posted[0].id, ok: false, error: 'scan failed' })
    expect(await claude).toEqual(new Error('scan failed'))
    expect(workers[0].terminate).not.toHaveBeenCalled()
    workers[0].complete(1)
    expect(await codex).toEqual({
      operation: 'scan',
      providerId: 'codex',
      sessions: [],
      dailyAggregates: []
    })
  })

  it('cancels a parked wake when disposed and cannot spawn after the exact exit', async () => {
    const { client, workers } = fixture()
    const active = client.scan(body('claude')).catch((error: unknown) => error)
    const pending = client.scan(body('claude')).catch((error: unknown) => error)
    let proveExit!: (code: number) => void
    workers[0].exit = new Promise((resolve) => {
      proveExit = resolve
    })
    workers[0].emit('error', new Error('worker crashed'))
    const disposed = client.dispose()
    expect(await active).toEqual(new Error('worker crashed'))
    expect(await pending).toEqual(new Error('Usage scan scheduler disposed'))
    proveExit(1)
    await disposed
    await vi.advanceTimersByTimeAsync(0)
    expect(workers).toHaveLength(1)
  })

  it('keeps failed termination fenced until actual exit and rejects strict disposal honestly', async () => {
    const { client, workers } = fixture()
    const first = client.scan(body('claude')).catch((error: unknown) => error)
    const pending = client.scan(body('claude')).catch((error: unknown) => error)
    const failure = new Error('termination failed')
    workers[0].exit = Promise.reject(failure)
    workers[0].emit('error', new Error('worker crashed'))
    expect(await first).toEqual(new Error('worker crashed'))
    expect(await pending).toBe(failure)
    expect(await client.scan(body('codex')).catch((error: unknown) => error)).toBe(failure)
    expect(workers).toHaveLength(1)
    await expect(client.dispose()).rejects.toBe(failure)
    workers[0].emit('exit', 1)
    await client.dispose()
  })

  it('preserves unavailable classification without falling back to caller-thread scans', async () => {
    const client = new UsageScanWorkerClient({
      workerFactory: () => {
        throw new Error('cannot spawn')
      },
      log: () => {}
    })
    clients.push(client)
    await expect(client.scan(body('claude'))).rejects.toBeInstanceOf(
      UsageScanWorkerUnavailableError
    )
  })
})
