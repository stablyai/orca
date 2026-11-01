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
import { withOpenCodeSqliteScanScope } from './session-scanner-opencode-sqlite-scan-scope'

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
  it('expires a scan in the FIFO without cancelling ordinary reads or a later scan', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const issues: AiVaultScanIssue[] = []
    try {
      const ordinary = [1, 2].map((id) =>
        client.list({
          dbPaths: [`/ordinary-${id}.db`],
          limit: 1,
          issues: []
        })
      )
      const scan = withOpenCodeSqliteScanScope(() =>
        client.list({
          dbPaths: ['/scan.db'],
          limit: 1,
          issues
        })
      )
      await vi.advanceTimersByTimeAsync(25_000)
      workers[0].emit('message', {
        id: workers[0].lastId(),
        ok: true,
        value: { candidates: [], issues: [] }
      })
      await vi.advanceTimersByTimeAsync(20_000)
      await expect(scan).resolves.toEqual([])
      expect(issues).toEqual([
        expect.objectContaining({
          kind: 'scope',
          message: expect.stringContaining('45s work budget')
        })
      ])
      expect(workers[0].postedRequests).toHaveLength(2)
      expect(workers[0].terminated).toBe(false)
      workers[0].emit('message', {
        id: workers[0].lastId(),
        ok: true,
        value: { candidates: [], issues: [] }
      })
      await expect(Promise.all(ordinary)).resolves.toEqual([[], []])
      const next = withOpenCodeSqliteScanScope(() =>
        client.list({ dbPaths: ['/next.db'], limit: 1, issues: [] })
      )
      workers[0].emit('message', {
        id: workers[0].lastId(),
        ok: true,
        value: { candidates: [], issues: [] }
      })
      await expect(next).resolves.toEqual([])
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it('correlates responses by id and ignores stale ids', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const parsePromise = client.parse({ dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const worker = workers[0]
    expect(worker).toBeDefined()
    expect(worker!.unrefed).toBe(true)

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

    expect(worker.postedRequests).toHaveLength(1)
    expect(worker.postedRequests[0]).toMatchObject({ kind: 'parse', sessionId: 'a' })

    worker.emit('message', { id: worker.postedRequests[0]!.id, ok: true, value: 'A' })
    await first

    expect(worker.postedRequests).toHaveLength(2)
    expect(worker.postedRequests[1]).toMatchObject({ kind: 'parse', sessionId: 'b' })
    worker.emit('message', { id: worker.postedRequests[1]!.id, ok: true, value: 'B' })
    await expect(second).resolves.toBe('B')
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
      const activeAssertion = expect(active).rejects.toThrow(
        `OpenCode SQLite worker timed out after ${PARSE_TIMEOUT_MS}ms`
      )

      // Queued calls must not spend their timeout before dispatch.
      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS)
      await activeAssertion

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
    const activeAssertion = expect(active).rejects.toThrow(
      'OpenCode SQLite worker exited with code 1'
    )

    workers[0]!.emit('exit', 1)
    await activeAssertion
    expect(workers[0]!.terminated).toBe(true)

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
      listIssues.some((issue) => issue.message.includes('background scanner could not start'))
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
    // Preserve the final crash reason when failing the remaining queue.
    const settled = pending.map((promise) => expect(promise).rejects.toThrow(/crash \d/))

    for (let i = 0; i < MAX_CONSECUTIVE_DEATHS; i++) {
      expect(workers[i]).toBeDefined()
      workers[i]!.emit('error', new Error(`crash ${i}`))
    }

    await Promise.all(settled)
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
    // A missing worker must fail closed for this scan without latching failure across future scans.
    const firstIssues: AiVaultScanIssue[] = []
    const first = await client.list({ dbPaths: ['/db'], limit: 10, issues: firstIssues })
    expect(first).toEqual([])
    expect(
      firstIssues.some((issue) => issue.message.includes('background scanner could not start'))
    ).toBe(true)
    await expect(
      client.parse({ dbPath: '/db', sessionId: 'ses_heal', platform: 'darwin' })
    ).rejects.toThrow(/background scanner could not start/)
    expect(workers).toHaveLength(0)

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

    // End the first burst after one death without a successful response to reset the counter.
    const first = client.parse({ dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const firstAssertion = expect(first).rejects.toThrow(/exited with code/)
    workers[0]!.emit('exit', 1)
    await firstAssertion

    // A fresh idle-to-active burst gets the full death budget despite the earlier failed burst.
    const pending = Array.from({ length: MAX_CONSECUTIVE_DEATHS }, (_, i) =>
      client.parse({ dbPath: `/db#b${i}`, sessionId: `b${i}`, platform: 'darwin' })
    )
    const settled = pending.map((promise) => expect(promise).rejects.toThrow())
    for (let i = 0; i < MAX_CONSECUTIVE_DEATHS; i++) {
      workers.at(-1)!.emit('error', new Error(`b-crash ${i}`))
    }
    await Promise.all(settled)
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
