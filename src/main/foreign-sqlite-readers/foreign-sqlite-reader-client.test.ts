import { describe, expect, it, vi } from 'vitest'
import type { WorkerRequestTransport } from '../worker-threads/worker-thread-transport'
import { ForeignSqliteReaderClient, ForeignSqliteReaderLane } from './foreign-sqlite-reader-client'
import type { ForeignSqliteReaderRequest } from './foreign-sqlite-reader-protocol'

const FAILURE = { status: 'error', error: 'Unable to read the Cursor desktop login' }

class FakeWorker implements WorkerRequestTransport {
  posted: ForeignSqliteReaderRequest[] = []
  terminated = false
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

  removeAllListeners(): this {
    this.listeners.clear()
    return this
  }

  unref(): void {}

  async terminate(): Promise<number> {
    this.terminated = true
    return 1
  }

  postMessage(request: ForeignSqliteReaderRequest): void {
    this.posted.push(request)
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of Array.from(this.listeners.get(event) ?? [])) {
      listener(arg)
    }
  }

  reply(value: unknown): void {
    const last = this.posted.at(-1)
    if (!last) {
      throw new Error('no request posted')
    }
    this.emit('message', { id: last.id, ok: true, value })
  }
}

function fakeFactory(workers: FakeWorker[]): () => FakeWorker {
  return () => {
    const worker = new FakeWorker()
    workers.push(worker)
    return worker
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('ForeignSqliteReaderClient', () => {
  it('includes queue time in the native failure deadline and removes expired work', async () => {
    vi.useFakeTimers()
    const workers: FakeWorker[] = []
    const client = new ForeignSqliteReaderClient({ workerFactory: fakeFactory(workers), log() {} })
    try {
      const query = { dbPath: '/a/opencode.db', sessionId: 'a', startedAt: 100, failedAt: 200 }
      const first = client.readOpenCodePromptFailure(query)
      const second = client.readOpenCodePromptFailure({ ...query, sessionId: 'b' })
      let queued: unknown
      void second.then((value) => {
        queued = value
      })
      await vi.advanceTimersByTimeAsync(1_999)
      workers[0]?.reply({ failure: null })
      await first
      await vi.advanceTimersByTimeAsync(1)
      expect(queued).toEqual({ failure: null })
      expect(workers[0]?.terminated).toBe(true)
    } finally {
      client.dispose()
      vi.useRealTimers()
    }
  })

  it('does not share native prompt evidence across different turns in the same session', async () => {
    const workers: FakeWorker[] = []
    const client = new ForeignSqliteReaderClient({ workerFactory: fakeFactory(workers), log() {} })
    const query = { dbPath: '/a/opencode.db', sessionId: 'ses-own', startedAt: 100, failedAt: 200 }
    const first = client.readOpenCodePromptFailure(query)
    expect(client.readOpenCodePromptFailure(query)).toBe(first)
    const next = client.readOpenCodePromptFailure({ ...query, startedAt: 300, failedAt: 400 })
    const quota = {
      failure: { inputId: 'input', type: 'provider.quota', message: 'Quota exhausted', status: 429 }
    }
    workers[0]?.reply(quota)
    await expect(first).resolves.toEqual(quota)
    await settle()
    workers[0]?.reply({ failure: null })
    await expect(next).resolves.toEqual({ failure: null })
    expect(workers[0]?.posted.map((request) => request.kind)).toEqual([
      'openCodePromptFailure',
      'openCodePromptFailure'
    ])
    client.dispose()
  })

  it('returns the failure value when the read times out', async () => {
    const workers: FakeWorker[] = []
    const client = new ForeignSqliteReaderClient({
      workerFactory: fakeFactory(workers),
      log() {},
      timeoutMs: 5
    })
    await expect(client.readCursorProfile('/a/state.vscdb')).resolves.toEqual(FAILURE)
    expect(workers[0]?.terminated).toBe(true)
    client.dispose()
  })

  it('returns the failure value when the worker crashes', async () => {
    const workers: FakeWorker[] = []
    const client = new ForeignSqliteReaderClient({ workerFactory: fakeFactory(workers), log() {} })
    const read = client.readCursorProfile('/a/state.vscdb')
    workers[0]?.emit('exit', 1)
    await expect(read).resolves.toEqual(FAILURE)
    client.dispose()
  })

  it('returns the failure value when the worker replies with an error or a malformed value', async () => {
    const workers: FakeWorker[] = []
    const client = new ForeignSqliteReaderClient({ workerFactory: fakeFactory(workers), log() {} })
    const errored = client.readCursorProfile('/a/state.vscdb')
    workers[0]?.emit('message', { id: workers[0].posted[0]?.id, ok: false, error: 'boom' })
    await expect(errored).resolves.toEqual(FAILURE)
    const malformed = client.readCursorProfile('/a/state.vscdb')
    workers[0]?.reply({ status: 'ok' })
    await expect(malformed).resolves.toEqual(FAILURE)
    client.dispose()
  })
})

describe('ForeignSqliteReaderLane', () => {
  it('gives each reader its own thread from the same factory', async () => {
    const workers: FakeWorker[] = []
    const settings = {
      workerFactory: fakeFactory(workers),
      log() {},
      timeoutMs: 60_000,
      idleTeardownMs: 30_000
    }
    const parse = (value: unknown): unknown => value
    const failure = (): unknown => 'failed'
    const slow = new ForeignSqliteReaderLane('cursorProfile', parse, failure, settings)
    const other = new ForeignSqliteReaderLane('cursorProfile', parse, failure, settings)

    const stuck = slow.read('/slow.db', (id) => ({ id, kind: 'cursorProfile', dbPath: '/slow.db' }))
    const quick = other.read('/quick.db', (id) => ({
      id,
      kind: 'cursorProfile',
      dbPath: '/quick.db'
    }))
    expect(workers).toHaveLength(2)
    workers[1]?.reply('quick')
    await expect(quick).resolves.toBe('quick')
    workers[0]?.reply('slow')
    await expect(stuck).resolves.toBe('slow')
    slow.dispose()
    other.dispose()
  })

  it('fails reads past the queue cap instead of piling them up', async () => {
    const workers: FakeWorker[] = []
    const lane = new ForeignSqliteReaderLane(
      'cursorProfile',
      (value) => value,
      () => 'failed',
      {
        workerFactory: fakeFactory(workers),
        log() {},
        timeoutMs: 60_000,
        idleTeardownMs: 30_000
      }
    )
    const reads = Array.from({ length: 10 }, (_, index) =>
      lane.read(`/db-${index}`, (id) => ({ id, kind: 'cursorProfile', dbPath: `/db-${index}` }))
    )
    await expect(reads[9]).resolves.toBe('failed')
    expect(workers[0]?.posted).toHaveLength(1)
    workers[0]?.reply('first')
    await expect(reads[0]).resolves.toBe('first')
    lane.dispose()
  })
})

describe('ForeignSqliteReaderClient OpenCode binder sessions', () => {
  const START = { ms: 0, id: '' }

  it('returns no sessions on a worker error, a malformed reply or a crash', async () => {
    const workers: FakeWorker[] = []
    const client = new ForeignSqliteReaderClient({
      workerFactory: fakeFactory(workers),
      log() {}
    })
    const errored = client.readOpenCodeBinderSessions('/o/opencode.db', START)
    workers[0]?.emit('message', { id: workers[0].posted[0]?.id, ok: false, error: 'busy' })
    await expect(errored).resolves.toEqual([])
    const malformed = client.readOpenCodeBinderSessions('/o/opencode.db', START)
    workers[0]?.reply([{ id: 'ses_a' }])
    await expect(malformed).resolves.toEqual([])
    const crashed = client.readOpenCodeBinderSessions('/o/opencode.db', START)
    workers[0]?.emit('exit', 1)
    await expect(crashed).resolves.toEqual([])
    client.dispose()
  })

  it('does not share an in-flight read across cursors', async () => {
    const workers: FakeWorker[] = []
    const client = new ForeignSqliteReaderClient({ workerFactory: fakeFactory(workers), log() {} })
    const stale = client.readOpenCodeBinderSessions('/o/opencode.db', { ms: 100, id: 'ses_a' })
    const restarted = client.readOpenCodeBinderSessions('/o/opencode.db', START)
    expect(restarted).not.toBe(stale)
    expect(client.readOpenCodeBinderSessions('/o/opencode.db', START)).toBe(restarted)
    client.dispose()
  })
})
