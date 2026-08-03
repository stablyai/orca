import type { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LIST_TIMEOUT_MS,
  OpenCodeSqliteWorkerClient,
  PARSE_TIMEOUT_MS
} from './session-scanner-opencode-sqlite-worker-client'
import {
  IDLE_TEARDOWN_MS,
  MAX_CONSECUTIVE_DEATHS,
  MAX_CONSECUTIVE_TIMEOUTS
} from './session-scanner-opencode-sqlite-worker-transport'
import type { OpenCodeSqliteWorkerResponse } from './session-scanner-opencode-sqlite-worker-protocol'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { OpenCodeSqliteScanContext } from './session-scanner-opencode-sqlite-scan-context'
import {
  FakeOpenCodeSqliteWorker as FakeWorker,
  makeFakeOpenCodeSqliteWorkerFactory as makeFactory
} from './fake-opencode-sqlite-worker'

function emitSettlementRaceEvent(worker: FakeWorker, event: 'message' | 'error' | 'exit'): void {
  if (event === 'message') {
    worker.emit('message', { id: worker.lastId(), ok: true, value: 'response' })
  } else if (event === 'error') {
    worker.emit('error', new Error('worker race error'))
  } else {
    worker.emit('exit', 1)
  }
}

function watchInternalSettlement(client: OpenCodeSqliteWorkerClient): {
  callbackCount: () => number
  settleCount: () => number
} {
  type Settle = (call: unknown, run: () => void) => void
  const transport = (client as unknown as { transport: { settle: Settle } }).transport
  const originalSettle = transport.settle.bind(transport)
  let callbacks = 0
  const settle = vi.spyOn(transport, 'settle').mockImplementation((call, run) => {
    originalSettle(call, () => {
      callbacks += 1
      run()
    })
  })
  return {
    callbackCount: () => callbacks,
    settleCount: () => settle.mock.calls.length
  }
}

// The transport waits for a destroyed worker to actually die before spawning a
// replacement — OpenCode's SQLite reads are synchronous, so `terminate()` is not
// instant and a second thread started early would double the CPU cost. That puts
// every respawn a few microtasks after the fault that caused it.
// Microtasks only, never a macrotask: fake timers mock setImmediate, so a
// timer-based flush would deadlock the tests that use them.
async function flushWorkerTeardown(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve()
  }
}

// The budget clock is armed by the scan phases, not by construction; transport
// tests drive contexts whose SQLite leg is already running.
function armedScanContext(deadlineMs?: number): OpenCodeSqliteScanContext {
  const scanContext = new OpenCodeSqliteScanContext(deadlineMs)
  scanContext.armDeadline()
  return scanContext
}

let context: OpenCodeSqliteScanContext

beforeEach(() => {
  context = armedScanContext()
})

afterEach(() => {
  context.dispose()
})

describe('OpenCodeSqliteWorkerClient', () => {
  it('correlates responses by id and ignores stale ids', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const parsePromise = client.parse({
      context,
      dbPath: '/db#a',
      sessionId: 'a',
      platform: 'darwin'
    })
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

    const first = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const second = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
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

      const active = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
      const queued = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
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

    const active = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    const queued = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
    const activeAssertion = expect(active).rejects.toThrow(/exited with code/)

    workers[0]!.emit('exit', 1)
    await activeAssertion
    expect(workers[0]!.terminated).toBe(true)

    // Exactly one respawn; the queued call drains on the new worker.
    expect(workers).toHaveLength(2)
    const respawned = workers[1]!
    workers[0]!.emit('error', new Error('late old-worker fault'))
    workers[0]!.emit('message', { id: respawned.lastId(), ok: true, value: 'stale' })
    expect(workers).toHaveLength(2)
    respawned.emit('message', { id: respawned.lastId(), ok: true, value: 'B' })
    await expect(queued).resolves.toBe('B')
  })

  it('treats a synchronous postMessage throw as a worker fault', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory() {
        const worker = new FakeWorker()
        if (workers.length === 0) {
          worker.postMessageError = new Error('post failed')
        }
        workers.push(worker)
        return worker as unknown as Worker
      },
      log() {}
    })

    await expect(
      client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    ).rejects.toThrow(/post failed/)
    const recovered = client.parse({
      context,
      dbPath: '/db#b',
      sessionId: 'b',
      platform: 'darwin'
    })
    workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'B' })
    await expect(recovered).resolves.toBe('B')
  })

  it('uses one queue-inclusive deadline and preserves unrelated FIFO work', async () => {
    vi.useFakeTimers()
    const expiringContext = armedScanContext(10)
    const retainedContext = armedScanContext(1_000)
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })
      const active = client.parse({
        context: expiringContext,
        dbPath: '/db#a',
        sessionId: 'a',
        platform: 'darwin'
      })
      const retained = client.parse({
        context: retainedContext,
        dbPath: '/db#b',
        sessionId: 'b',
        platform: 'darwin'
      })
      const queued = client.parse({
        context: expiringContext,
        dbPath: '/db#a2',
        sessionId: 'a2',
        platform: 'darwin'
      })
      const activeRejection = expect(active).rejects.toThrow(/deadline elapsed/)
      const queuedRejection = expect(queued).rejects.toThrow(/deadline elapsed/)

      await vi.advanceTimersByTimeAsync(10)
      await Promise.all([activeRejection, queuedRejection])
      expect(workers[0]!.terminated).toBe(true)
      expect(workers).toHaveLength(2)
      workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'B' })
      await expect(retained).resolves.toBe('B')
      expect(expiringContext.metrics()).toMatchObject({
        deadlineExpired: true,
        queueWaitMs: 10,
        workOmitted: true
      })
    } finally {
      expiringContext.dispose()
      retainedContext.dispose()
      vi.useRealTimers()
    }
  })

  it('cleans up once when the per-call timeout wins a later context abort', async () => {
    vi.useFakeTimers()
    const timeoutContext = armedScanContext(PARSE_TIMEOUT_MS * 2)
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })
      const settlement = watchInternalSettlement(client)
      const addListener = vi.spyOn(timeoutContext.signal, 'addEventListener')
      const removeListener = vi.spyOn(timeoutContext.signal, 'removeEventListener')
      const outcome = client
        .parse({
          context: timeoutContext,
          dbPath: '/db#a',
          sessionId: 'a',
          platform: 'darwin'
        })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))

      expect(vi.getTimerCount()).toBe(2)
      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS)
      await expect(outcome).resolves.toMatch(/timed out/)
      expect(settlement.settleCount()).toBe(1)
      expect(settlement.callbackCount()).toBe(1)
      expect(addListener).toHaveBeenCalledTimes(1)
      expect(removeListener).toHaveBeenCalledTimes(1)
      expect(workers[0]!.listenerCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(1)

      timeoutContext.dispose()
      emitSettlementRaceEvent(workers[0]!, 'message')
      emitSettlementRaceEvent(workers[0]!, 'error')
      emitSettlementRaceEvent(workers[0]!, 'exit')
      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS)
      expect(settlement.settleCount()).toBe(1)
      expect(settlement.callbackCount()).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      timeoutContext.dispose()
      vi.useRealTimers()
    }
  })

  it('cancels queued work without terminating another context active on the worker', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const activeContext = armedScanContext()
    const queuedContext = armedScanContext()
    try {
      const active = client.parse({
        context: activeContext,
        dbPath: '/db#b',
        sessionId: 'b',
        platform: 'darwin'
      })
      const queued = client.parse({
        context: queuedContext,
        dbPath: '/db#a',
        sessionId: 'a',
        platform: 'darwin'
      })
      const queuedRejection = expect(queued).rejects.toThrow(/scan ended/)

      queuedContext.dispose()
      await queuedRejection
      expect(workers[0]!.terminated).toBe(false)
      workers[0]!.emit('message', { id: workers[0]!.lastId(), ok: true, value: 'B' })
      await expect(active).resolves.toBe('B')
      expect(queuedContext.metrics().workOmitted).toBe(true)
    } finally {
      activeContext.dispose()
      queuedContext.dispose()
    }
  })

  it('dispose cancels active and queued work owned by an exceptional scan exit', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const exceptionalContext = armedScanContext()
    const active = client.parse({
      context: exceptionalContext,
      dbPath: '/db#a',
      sessionId: 'a',
      platform: 'darwin'
    })
    const queued = client.parse({
      context: exceptionalContext,
      dbPath: '/db#a2',
      sessionId: 'a2',
      platform: 'darwin'
    })
    const activeRejection = expect(active).rejects.toThrow(/scan ended/)
    const queuedRejection = expect(queued).rejects.toThrow(/scan ended/)

    exceptionalContext.dispose()
    await Promise.all([activeRejection, queuedRejection])
    expect(workers[0]!.terminated).toBe(true)
    expect(exceptionalContext.metrics().workOmitted).toBe(true)
  })

  it.each(['message', 'error', 'exit'] as const)(
    'cleans up once when context abort wins the %s and timeout races',
    async (event) => {
      vi.useFakeTimers()
      const raceContext = armedScanContext(PARSE_TIMEOUT_MS * 2)
      try {
        const workers: FakeWorker[] = []
        const client = new OpenCodeSqliteWorkerClient({
          workerFactory: makeFactory(workers),
          log() {}
        })
        const settlement = watchInternalSettlement(client)
        const addListener = vi.spyOn(raceContext.signal, 'addEventListener')
        const removeListener = vi.spyOn(raceContext.signal, 'removeEventListener')
        const parse = client.parse({
          context: raceContext,
          dbPath: '/db#a',
          sessionId: 'a',
          platform: 'darwin'
        })
        const rejection = expect(parse).rejects.toThrow(/scan ended/)

        expect(vi.getTimerCount()).toBe(2)
        raceContext.dispose()
        await rejection
        expect(settlement.settleCount()).toBe(1)
        expect(settlement.callbackCount()).toBe(1)
        expect(addListener).toHaveBeenCalledTimes(1)
        expect(removeListener).toHaveBeenCalledTimes(1)
        expect(workers[0]!.listenerCount()).toBe(0)
        expect(vi.getTimerCount()).toBe(0)

        emitSettlementRaceEvent(workers[0]!, event)
        await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS)
        expect(settlement.settleCount()).toBe(1)
        expect(settlement.callbackCount()).toBe(1)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        raceContext.dispose()
        vi.useRealTimers()
      }
    }
  )

  it.each(['message', 'error', 'exit'] as const)(
    'cleans up once when worker %s wins the context-abort race',
    async (event) => {
      vi.useFakeTimers()
      const raceContext = armedScanContext(PARSE_TIMEOUT_MS * 2)
      try {
        const workers: FakeWorker[] = []
        const client = new OpenCodeSqliteWorkerClient({
          workerFactory: makeFactory(workers),
          log() {}
        })
        const settlement = watchInternalSettlement(client)
        const addListener = vi.spyOn(raceContext.signal, 'addEventListener')
        const removeListener = vi.spyOn(raceContext.signal, 'removeEventListener')
        const outcome = client
          .parse({
            context: raceContext,
            dbPath: '/db#a',
            sessionId: 'a',
            platform: 'darwin'
          })
          .then(
            (value) => ({ error: null, value }),
            (error: unknown) => ({
              error: error instanceof Error ? error.message : String(error),
              value: null
            })
          )

        expect(vi.getTimerCount()).toBe(2)
        emitSettlementRaceEvent(workers[0]!, event)
        const settled = await outcome
        expect(settlement.settleCount()).toBe(1)
        expect(settlement.callbackCount()).toBe(1)
        expect(addListener).toHaveBeenCalledTimes(1)
        expect(removeListener).toHaveBeenCalledTimes(1)
        if (event === 'message') {
          expect(settled.error).toBeNull()
        } else {
          expect(settled.error).toEqual(expect.any(String))
        }

        raceContext.dispose()
        emitSettlementRaceEvent(workers[0]!, event)
        if (event === 'message') {
          expect(workers[0]!.listenerCount()).toBe(3)
          expect(vi.getTimerCount()).toBe(1)
          await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)
        }
        expect(workers[0]!.listenerCount()).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
        expect(settlement.settleCount()).toBe(1)
        expect(settlement.callbackCount()).toBe(1)
      } finally {
        raceContext.dispose()
        vi.useRealTimers()
      }
    }
  )

  it('fails closed instead of running SQLite on the main thread when spawn fails', async () => {
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory() {
        throw new Error('no worker bundle')
      },
      log() {}
    })

    const listIssues: AiVaultScanIssue[] = []
    await expect(
      client.list({ context, dbPaths: ['/tmp/opencode.db'], limit: 10, issues: listIssues })
    ).resolves.toEqual([])
    expect(listIssues).toEqual([])
    expect(context.metrics().terminationReason).toBe('workerUnavailable')
    await expect(
      client.parse({
        context,
        dbPath: '/tmp/opencode.db',
        sessionId: 'ses_skipped',
        platform: 'darwin'
      })
    ).rejects.toThrow(/could not be started/)
  })

  // Why: the transport is a process-wide singleton shared by every concurrent
  // scan. A transient spawn failure that drained the whole queue would erase
  // OpenCode history for scans that had nothing to do with it.
  it('fails only the call that hit a spawn failure, not another scan behind it', async () => {
    const workers: FakeWorker[] = []
    let spawnAttempts = 0
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory: () => {
        spawnAttempts += 1
        // The very first spawn succeeds so a call can occupy the worker; the
        // next one fails; the one after that recovers.
        if (spawnAttempts === 2) {
          throw new Error('transient spawn failure')
        }
        const worker = new FakeWorker()
        workers.push(worker)
        return worker as unknown as Worker
      },
      log() {}
    })
    const otherContext = armedScanContext()

    try {
      const active = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
      // Queued behind the active call, so both are pending when the worker dies.
      const queuedOwn = client
        .parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
        .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      const queuedOther = client.parse({
        context: otherContext,
        dbPath: '/db#c',
        sessionId: 'c',
        platform: 'darwin'
      })

      workers[0]!.emit('error', new Error('worker died'))
      await expect(active).rejects.toThrow(/worker died/)
      await flushWorkerTeardown()

      // The respawn threw for the head call only; the call behind it got the
      // retry and a live worker.
      await expect(queuedOwn).resolves.toMatch(/background scanner could not start/)
      expect(workers).toHaveLength(2)
      workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'C' })
      await expect(queuedOther).resolves.toBe('C')
    } finally {
      otherContext.dispose()
    }
  })

  // Why: a worker answering slowly is not a worker that died. Reporting a large
  // database as a crash sends people looking for the wrong problem.
  it('trips a timeout circuit, not the crash circuit, when calls keep timing out', async () => {
    vi.useFakeTimers()
    const timeoutContext = armedScanContext(PARSE_TIMEOUT_MS * (MAX_CONSECUTIVE_TIMEOUTS + 4))
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })

      const pending = Array.from({ length: MAX_CONSECUTIVE_TIMEOUTS }, (_, index) =>
        client
          .parse({
            context: timeoutContext,
            dbPath: `/db#${index}`,
            sessionId: `s${index}`,
            platform: 'darwin'
          })
          .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      )

      for (let index = 0; index < MAX_CONSECUTIVE_TIMEOUTS; index += 1) {
        await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS)
        await flushWorkerTeardown()
      }
      for (const outcome of pending) {
        await expect(outcome).resolves.toMatch(/timed out|kept timing out|cancelled/)
      }

      expect(timeoutContext.isTerminated).toBe(true)
      expect(timeoutContext.metrics().terminationReason).toBe('workerTimeoutLoop')
      // Never spawned more workers than the timeout budget allows.
      expect(workers.length).toBeLessThanOrEqual(MAX_CONSECUTIVE_TIMEOUTS)
    } finally {
      timeoutContext.dispose()
      vi.useRealTimers()
    }
  })

  it('rejects already-aborted work without spawning a worker', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const abortedContext = armedScanContext()
    abortedContext.dispose()

    await expect(
      client.parse({
        context: abortedContext,
        dbPath: '/db#a',
        sessionId: 'a',
        platform: 'darwin'
      })
    ).rejects.toThrow(/scan ended/)
    expect(workers).toEqual([])
    expect(abortedContext.metrics().workOmitted).toBe(true)
  })

  it('stops respawning after the consecutive-death cap and fails the rest to issues', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const pending = Array.from({ length: MAX_CONSECUTIVE_DEATHS + 2 }, (_, i) =>
      client.parse({ context, dbPath: `/db#${i}`, sessionId: `s${i}`, platform: 'darwin' })
    )
    const settled = pending.map((promise) => expect(promise).rejects.toThrow())

    // Crash every worker as it is spawned; the client respawns up to the cap.
    for (let i = 0; i < MAX_CONSECUTIVE_DEATHS; i++) {
      await flushWorkerTeardown()
      expect(workers[i]).toBeDefined()
      workers[i]!.emit('error', new Error(`crash ${i}`))
    }
    await flushWorkerTeardown()

    await Promise.all(settled)
    // No respawn past the cap: only MAX_CONSECUTIVE_DEATHS workers were created,
    // and the queued remainder failed to scan issues rather than looping.
    expect(workers).toHaveLength(MAX_CONSECUTIVE_DEATHS)
  })

  it('leaves a single list timeout below the consecutive-failure circuit threshold', async () => {
    vi.useFakeTimers()
    try {
      const workers: FakeWorker[] = []
      const client = new OpenCodeSqliteWorkerClient({
        workerFactory: makeFactory(workers),
        log() {}
      })
      const issues: AiVaultScanIssue[] = []
      const listPromise = client.list({
        context,
        dbPaths: ['/tmp/opencode.db'],
        limit: 10,
        issues
      })
      // The list request is dispatched but never answered. Outcome reporting,
      // not this transport client, owns the single user-facing diagnostic.
      await vi.advanceTimersByTimeAsync(LIST_TIMEOUT_MS)
      await expect(listPromise).resolves.toEqual([])
      expect(issues).toEqual([])
      expect(context.metrics()).toMatchObject({
        sqliteListCancelled: true,
        terminationReason: null,
        workOmitted: true
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminates the scan when the worker rejects the list request', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory: makeFactory(workers),
      log() {}
    })
    const issues: AiVaultScanIssue[] = []
    const listPromise = client.list({
      context,
      dbPaths: ['/tmp/opencode.db'],
      limit: 10,
      issues
    })
    workers[0]!.emit('message', {
      id: workers[0]!.lastId(),
      ok: false,
      error: 'list handler failed'
    } satisfies OpenCodeSqliteWorkerResponse)

    await expect(listPromise).resolves.toEqual([])
    expect(context.metrics().terminationReason).toBe('listFailed')
    expect(issues).toEqual([])
  })

  it('leaves a single list worker fault below the consecutive-death threshold', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({
      workerFactory: makeFactory(workers),
      log() {}
    })
    const issues: AiVaultScanIssue[] = []
    const listPromise = client.list({
      context,
      dbPaths: ['/tmp/opencode.db'],
      limit: 10,
      issues
    })

    workers[0]!.emit('error', new Error('single list fault'))

    await expect(listPromise).resolves.toEqual([])
    expect(issues).toEqual([])
    expect(context.metrics()).toMatchObject({
      sqliteListCancelled: true,
      terminationReason: null,
      workOmitted: true
    })
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
    // Scan 1 fails closed and terminates only its own context.
    const firstIssues: AiVaultScanIssue[] = []
    const first = await client.list({ context, dbPaths: ['/db'], limit: 10, issues: firstIssues })
    expect(first).toEqual([])
    expect(firstIssues).toEqual([])
    expect(context.metrics().terminationReason).toBe('workerUnavailable')
    expect(workers).toHaveLength(0)

    // Spawns recover; the next scan must re-probe and use the worker.
    failSpawns = false
    const recoveredContext = armedScanContext()
    const secondIssues: AiVaultScanIssue[] = []
    try {
      const secondPromise = client.list({
        context: recoveredContext,
        dbPaths: ['/db'],
        limit: 10,
        issues: secondIssues
      })
      const worker = workers[0]
      expect(worker).toBeDefined()
      worker!.emit('message', {
        id: worker!.lastId(),
        ok: true,
        value: { candidates: [], issues: [] }
      } satisfies OpenCodeSqliteWorkerResponse)
      await expect(secondPromise).resolves.toEqual([])
      expect(secondIssues).toHaveLength(0)
    } finally {
      recoveredContext.dispose()
    }
  })

  it('drops a cleanly exited idle worker and respawns on the next request', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    const first = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
    workers[0]!.emit('message', { id: workers[0]!.lastId(), ok: true, value: 'A' })
    await expect(first).resolves.toBe('A')
    workers[0]!.emit('exit', 0)
    await flushWorkerTeardown()

    const second = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
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

      const first = client.parse({ context, dbPath: '/db#a', sessionId: 'a', platform: 'darwin' })
      workers[0]!.emit('message', { id: workers[0]!.lastId(), ok: true, value: 'A' })
      await expect(first).resolves.toBe('A')
      await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)
      expect(workers[0]!.terminated).toBe(true)

      const second = client.parse({ context, dbPath: '/db#b', sessionId: 'b', platform: 'darwin' })
      expect(workers).toHaveLength(2)
      workers[1]!.emit('message', { id: workers[1]!.lastId(), ok: true, value: 'B' })
      await expect(second).resolves.toBe('B')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retains scan fault state across queue-empty parser batches', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })
    const otherContext = armedScanContext()
    const addListener = vi.spyOn(context.signal, 'addEventListener')
    const removeListener = vi.spyOn(context.signal, 'removeEventListener')

    try {
      for (let index = 0; index < MAX_CONSECUTIVE_DEATHS - 1; index += 1) {
        const batch = client.parse({
          context,
          dbPath: `/db#a${index}`,
          sessionId: `a${index}`,
          platform: 'darwin'
        })
        const rejection = expect(batch).rejects.toThrow(/batch crash/)
        workers.at(-1)!.emit('error', new Error(`batch crash ${index}`))
        await rejection
        expect(addListener).toHaveBeenCalledTimes(index + 1)
        expect(removeListener).toHaveBeenCalledTimes(index + 1)

        const interleaved = client.parse({
          context: otherContext,
          dbPath: `/db#b${index}`,
          sessionId: `b${index}`,
          platform: 'darwin'
        })
        workers.at(-1)!.emit('message', {
          id: workers.at(-1)!.lastId(),
          ok: true,
          value: `B${index}`
        })
        await expect(interleaved).resolves.toBe(`B${index}`)
      }

      const third = client.parse({
        context,
        dbPath: '/db#a2',
        sessionId: 'a2',
        platform: 'darwin'
      })
      const retained = client.parse({
        context: otherContext,
        dbPath: '/db#b',
        sessionId: 'b',
        platform: 'darwin'
      })
      const skipped = client.parse({
        context,
        dbPath: '/db#a3',
        sessionId: 'a3',
        platform: 'darwin'
      })
      const thirdRejection = expect(third).rejects.toThrow(/third crash/)
      const skippedRejection = expect(skipped).rejects.toThrow(/crashed repeatedly/)
      workers.at(-1)!.emit('error', new Error('third crash'))
      await Promise.all([thirdRejection, skippedRejection])

      const retainedWorker = workers.at(-1)!
      retainedWorker.emit('message', {
        id: retainedWorker.lastId(),
        ok: true,
        value: 'B'
      })
      await expect(retained).resolves.toBe('B')
      expect(workers).toHaveLength(MAX_CONSECUTIVE_DEATHS + 1)
      expect(addListener).toHaveBeenCalledTimes(MAX_CONSECUTIVE_DEATHS)
      expect(removeListener).toHaveBeenCalledTimes(MAX_CONSECUTIVE_DEATHS)
    } finally {
      otherContext.dispose()
    }
  })

  it('reuses the warm worker across a burst without respawning', async () => {
    const workers: FakeWorker[] = []
    const client = new OpenCodeSqliteWorkerClient({ workerFactory: makeFactory(workers), log() {} })

    for (let i = 0; i < 3; i++) {
      const promise = client.parse({
        context,
        dbPath: `/db#${i}`,
        sessionId: `s${i}`,
        platform: 'darwin'
      })
      const worker = workers[0]!
      worker.emit('message', { id: worker.lastId(), ok: true, value: `v${i}` })
      await expect(promise).resolves.toBe(`v${i}`)
    }
    expect(workers).toHaveLength(1)
  })
})
