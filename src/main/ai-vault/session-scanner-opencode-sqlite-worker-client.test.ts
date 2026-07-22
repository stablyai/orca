import type { Worker } from 'node:worker_threads'
import { describe, expect, it, vi } from 'vitest'
import {
  IDLE_TEARDOWN_MS,
  LIST_TIMEOUT_MS,
  MAX_CONSECUTIVE_DEATHS,
  OpenCodeSqliteWorkerClient,
  PARSE_TIMEOUT_MS
} from './session-scanner-opencode-sqlite-worker-client'
import type {
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

// A worker_threads stand-in the tests drive directly: it records posted requests
// and lets a test emit message/error/exit without a built worker bundle.
class FakeWorker {
  postedRequests: OpenCodeSqliteWorkerRequest[] = []
  terminated = false
  unrefed = false
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

  unref(): void {
    this.unrefed = true
  }

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }

  postMessage(request: OpenCodeSqliteWorkerRequest): void {
    this.postedRequests.push(request)
  }

  emit(event: string, arg?: unknown): void {
    // Copy first: the client removes its listeners synchronously during a fault.
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }

  lastId(): number {
    const last = this.postedRequests.at(-1)
    if (!last) {
      throw new Error('no request posted to fake worker')
    }
    return last.id
  }
}

function makeFactory(workers: FakeWorker[]): () => Worker {
  return () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker as unknown as Worker
  }
}

describe('OpenCodeSqliteWorkerClient', () => {
  it('correlates responses by id and ignores stale ids', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const parsePromise = client.parse({ dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const worker = workers[0]
    expect(worker).toBeDefined()
    expect(worker!.unrefed).toBe(true)

    // A response for a different id must not settle the active call.
    worker!.emit('message', {
      id: 999,
      ok: true,
      value: null
    } satisfies OpenCodeSqliteWorkerResponse)
    worker!.emit('message', {
      id: worker!.lastId(),
      ok: true,
      value: { sessionId: 'a' }
    } satisfies OpenCodeSqliteWorkerResponse)

    await expect(parsePromise).resolves.toEqual({ sessionId: 'a' })
  })

  it('dispatches one request at a time in FIFO order', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const first = client.parse({ dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const second = client.parse({ dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
    const worker = workers[0]!

    // Only the first is dispatched; the second waits for the active slot.
    expect(worker.postedRequests).toHaveLength(1)
    expect(worker.postedRequests[0]).toMatchObject({ kind: 'parse', sessionId: 'a' })

    worker.emit('message', { id: worker.postedRequests[0]!.id, ok: true, value: 'A' })
    await first

    expect(worker.postedRequests).toHaveLength(2)
    expect(worker.postedRequests[1]).toMatchObject({ kind: 'parse', sessionId: 'b' })
    worker.emit('message', { id: worker.postedRequests[1]!.id, ok: true, value: 'B' })
    await expect(second).resolves.toBe('B')
    // The worker is reused across serial calls (one persistent worker).
    expect(workers).toHaveLength(1)
  })

  it('times out only the active call, then respawns and drains the queue', async () => {
    vi.useFakeTimers()
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })

      const active = client.parse({ dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
      const queued = client.parse({ dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
      const activeAssertion = expect(active).rejects.toThrow(/timed out/)

      // The queued call's timer must not have started while it waited, so only
      // the active call fires at the parse timeout.
      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS)
      await activeAssertion

      // Fault respawns a fresh worker and dispatches the still-queued call.
      expect(workers).toHaveLength(2)
      const respawned = workers[1]!
      expect(respawned.postedRequests).toHaveLength(1)
      expect(respawned.postedRequests[0]).toMatchObject({ sessionId: 'b' })
      respawned.emit('message', { id: respawned.lastId(), ok: true, value: 'B' })
      await expect(queued).resolves.toBe('B')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects only the active call on a worker crash and respawns for the queue', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const active = client.parse({ dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const queued = client.parse({ dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
    const activeAssertion = expect(active).rejects.toThrow(/exited with code/)

    workers[0]!.emit('exit', 1)
    await activeAssertion
    expect(workers[0]!.terminated).toBe(true)

    // Exactly one respawn; the queued call drains on the new worker.
    expect(workers).toHaveLength(2)
    const respawned = workers[1]!
    respawned.emit('message', { id: respawned.lastId(), ok: true, value: 'B' })
    await expect(queued).resolves.toBe('B')
  })

  it('fails closed instead of running SQLite on the main thread when spawn fails', async () => {
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory() {
        throw new Error('no worker bundle')
      },
      log() {}
    })

    const listIssues: AiVaultScanIssue[] = []
    await expect(
      client.list({ dbPaths: ['/tmp/opencode.db'], limit: 10, issues: listIssues })
    ).resolves.toEqual([])
    expect(
      listIssues.some((issue) => /background scanner could not start/.test(issue.message))
    ).toBe(true)
    await expect(
      client.parse({ dbPath: '/tmp/opencode.db', sessionId: 'ses_skipped', platform: 'darwin' })
    ).rejects.toThrow(/background scanner could not start/)
  })

  it('stops respawning after the consecutive-death cap and fails the rest to issues', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const pending = Array.from({ length: MAX_CONSECUTIVE_DEATHS + 2 }, (_, i) =>
      client.parse({ dbPath: `/db#${i}`, sessionId: `s${i}`, platform: 'darwin' })
    )
    const settled = pending.map((promise) => expect(promise).rejects.toThrow())

    // Crash every worker as it is spawned; the client respawns up to the cap.
    for (let i = 0; i < MAX_CONSECUTIVE_DEATHS; i++) {
      expect(workers[i]).toBeDefined()
      workers[i]!.emit('error', new Error(`crash ${i}`))
    }

    await Promise.all(settled)
    // No respawn past the cap: only MAX_CONSECUTIVE_DEATHS workers were created,
    // and the queued remainder failed to scan issues rather than looping.
    expect(workers).toHaveLength(MAX_CONSECUTIVE_DEATHS)
  })

  it('surfaces a list-leg timeout as a scan issue and returns no candidates', async () => {
    vi.useFakeTimers()
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })
      const issues: AiVaultScanIssue[] = []
      const listPromise = client.list({
        dbPaths: ['/tmp/opencode.db'],
        limit: 10,
        issues
      })
      // The list request is dispatched but never answered → it must time out into
      // a scan issue (not an unbounded stall) and contribute no sessions.
      await vi.advanceTimersByTimeAsync(LIST_TIMEOUT_MS)
      await expect(listPromise).resolves.toEqual([])
      expect(issues).toHaveLength(1)
      expect(issues[0]!.agent).toBe('opencode')
      expect(issues[0]!.message).toMatch(/did not complete/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('self-heals after repeated spawn failures instead of latching unavailable', async () => {
    const workers: FakeWorker[] = []
    let failSpawns = true
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory() {
        if (failSpawns) {
          throw new Error('spawn down')
        }
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as unknown as Worker
      },
      log() {}
    })
    // Scan 1: both calls fail closed, keeping synchronous SQLite off the main
    // thread. The failure is not latched, so a later scan can still recover.
    const firstIssues: AiVaultScanIssue[] = []
    const first = await client.list({ dbPaths: ['/db'], limit: 10, issues: firstIssues })
    expect(first).toEqual([])
    expect(
      firstIssues.some((issue) => /background scanner could not start/.test(issue.message))
    ).toBe(true)
    await expect(
      client.parse({ dbPath: '/db', sessionId: 'ses_heal', platform: 'darwin' })
    ).rejects.toThrow(/background scanner could not start/)
    expect(workers).toHaveLength(0)

    // Spawns recover; the next scan must re-probe and use the worker.
    failSpawns = false
    const secondIssues: AiVaultScanIssue[] = []
    const secondPromise = client.list({ dbPaths: ['/db'], limit: 10, issues: secondIssues })
    const worker = workers[0]
    expect(worker).toBeDefined()
    worker!.emit('message', {
      id: worker!.lastId(),
      ok: true,
      value: { candidates: [], issues: [] }
    } satisfies OpenCodeSqliteWorkerResponse)
    await expect(secondPromise).resolves.toEqual([])
    expect(secondIssues).toHaveLength(0)
  })

  it('drops a cleanly exited idle worker and respawns on the next request', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const first = client.parse({ dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    workers[0]!.emit('message', { id: workers[0]!.lastId(), ok: true, value: 'A' })
    await expect(first).resolves.toBe('A')
    workers[0]!.emit('exit', 0)

    const second = client.parse({ dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
    expect(workers).toHaveLength(2)
    workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'B' })
    await expect(second).resolves.toBe('B')
  })

  it('terminates an idle worker and respawns on later work', async () => {
    vi.useFakeTimers()
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })

      const first = client.parse({ dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
      workers[0]!.emit('message', { id: workers[0]!.lastId(), ok: true, value: 'A' })
      await expect(first).resolves.toBe('A')
      await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)
      expect(workers[0]!.terminated).toBe(true)

      const second = client.parse({ dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
      expect(workers).toHaveLength(2)
      workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'B' })
      await expect(second).resolves.toBe('B')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not carry a worker death from a prior burst into the next scan cap', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    // Burst 1: one parse whose worker dies, then the burst ends (queue empties)
    // with no success to reset the death counter.
    const first = client.parse({ dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const firstAssertion = expect(first).rejects.toThrow(/exited with code/)
    workers[0]!.emit('exit', 1)
    await firstAssertion

    // Burst 2 from idle: the fresh scan resets the cap, so MAX_CONSECUTIVE_DEATHS
    // brand-new workers must be spawned before the remainder drains — the carried
    // death from burst 1 does not count against burst 2.
    const pending = Array.from({ length: MAX_CONSECUTIVE_DEATHS }, (_, i) =>
      client.parse({ dbPath: `/db#b${i}`, sessionId: `b${i}`, platform: 'darwin' })
    )
    const settled = pending.map((promise) => expect(promise).rejects.toThrow())
    for (let i = 0; i < MAX_CONSECUTIVE_DEATHS; i++) {
      workers.at(-1)!.emit('error', new Error(`b-crash ${i}`))
    }
    await Promise.all(settled)
    // One worker from burst 1 plus a fresh worker per allowed death in burst 2.
    expect(workers).toHaveLength(1 + MAX_CONSECUTIVE_DEATHS)
  })

  it('reuses the warm worker across a burst without respawning', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    for (let i = 0; i < 3; i++) {
      const promise = client.parse({ dbPath: `/db#${i}`, sessionId: `s${i}`, platform: 'darwin' })
      const worker = workers[0]!
      worker.emit('message', { id: worker.lastId(), ok: true, value: `v${i}` })
      await expect(promise).resolves.toBe(`v${i}`)
    }
    expect(workers).toHaveLength(1)
  })
})
