import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as waitForPoll } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type * as SystemPowerLifecycle from '../../power/system-power-lifecycle'
import { publishSystemResume } from '../../power/system-power-lifecycle'
import type * as WriterDiagnostics from './profile-state-writer-diagnostics'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'

const power = vi.hoisted(() => ({ subscriptions: 0 }))
vi.mock('../../power/system-power-lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof SystemPowerLifecycle>()
  return {
    ...actual,
    subscribeSystemPowerLifecycle: (
      listener: Parameters<typeof actual.subscribeSystemPowerLifecycle>[0]
    ) => {
      power.subscriptions += 1
      const unsubscribe = actual.subscribeSystemPowerLifecycle(listener)
      return () => {
        power.subscriptions -= 1
        unsubscribe()
      }
    }
  }
})
const diagnostics = vi.hoisted(() => ({ slow: vi.fn() }))
vi.mock('./profile-state-writer-diagnostics', async (importOriginal) => ({
  ...(await importOriginal<typeof WriterDiagnostics>()),
  recordProfileStateWriterSlow: diagnostics.slow
}))

const WARNING_MS = 30_000
const UNLIMITED = 2 ** 30
// Shared-memory slots: replies posted, replies allowed, exit allowed, worker starts.
const REPLIES = 0
const ALLOWED_REPLIES = 1
const EXIT_ALLOWED = 2
const STARTS = 3

const fixtures: {
  client: ProfileStateWriteWorkerClient
  releaseReplies: () => void
  releaseExit: () => void
}[] = []
const roots: string[] = []

afterEach(async () => {
  vi.useRealTimers()
  publishSystemResume()
  diagnostics.slow.mockReset()
  for (const fixture of fixtures) {
    fixture.releaseReplies()
    fixture.releaseExit()
  }
  await Promise.all(fixtures.splice(0).map(({ client }) => client.close().catch(() => {})))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Gate worker replies and exit through shared memory. */
function createClient({ holdReplies = false, holdExit = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-writer-sleep-'))
  roots.push(root)
  const workerPath = join(root, 'writer.cjs')
  writeFileSync(
    workerPath,
    `
    const { parentPort, workerData } = require('node:worker_threads')
    const shared = new Int32Array(workerData.shared)
    const awaitAtLeast = (index, minimum) => {
      for (let value = Atomics.load(shared, index); value < minimum; value = Atomics.load(shared, index)) {
        Atomics.wait(shared, index, value)
      }
    }
    const reply = message => {
      awaitAtLeast(${ALLOWED_REPLIES}, Atomics.load(shared, ${REPLIES}) + 1)
      parentPort.postMessage(message)
      Atomics.add(shared, ${REPLIES}, 1)
      Atomics.notify(shared, ${REPLIES})
    }
    Atomics.add(shared, ${STARTS}, 1)
    let revision = 1
    reply({ id: 0, ok: true, revision })
    parentPort.on('message', request => {
      if (request.command.startsWith('write-')) revision++
      const exported = request.command.startsWith('export-') ? { exportedRevision: revision } : {}
      reply({ id: request.id, ok: true, revision, ...exported })
      if (request.command === 'close') {
        awaitAtLeast(${EXIT_ALLOWED}, 1)
        parentPort.close()
      }
    })
    `
  )
  const buffer = new SharedArrayBuffer(16)
  const shared = new Int32Array(buffer)
  shared[ALLOWED_REPLIES] = holdReplies ? 0 : UNLIMITED
  shared[EXIT_ALLOWED] = holdExit ? 0 : 1
  const store = (index: number, value: number) => {
    Atomics.store(shared, index, value)
    Atomics.notify(shared, index)
  }
  const clock = { now: 0 }
  const onFailure = vi.fn()
  const onSaveDelayChanged = vi.fn()
  const initialization = {
    databasePath: join(root, 'unused.db'),
    profileId: 'sleep-test',
    revision: 1,
    shared: buffer
  }
  const client = new ProfileStateWriteWorkerClient(initialization, {
    workerPath,
    onFailure,
    onSaveDelayChanged,
    clock: () => clock.now
  })
  const fixture = {
    client,
    onFailure,
    onSaveDelayChanged,
    root,
    workerStarts: () => Atomics.load(shared, STARTS),
    holdReplies: () => store(ALLOWED_REPLIES, Atomics.load(shared, REPLIES)),
    releaseReplies: () => store(ALLOWED_REPLIES, UNLIMITED),
    releaseExit: () => store(EXIT_ALLOWED, 1),
    /** Wait synchronously for reply count; initialization is reply 1. */
    awaitQueuedReply: (count: number) => {
      const deadline = performance.now() + 5_000
      for (let posted = Atomics.load(shared, REPLIES); posted < count;) {
        const remaining = deadline - performance.now()
        if (remaining <= 0) {
          throw new Error(`Worker posted ${posted} of ${count} replies`)
        }
        Atomics.wait(shared, REPLIES, posted, remaining)
        posted = Atomics.load(shared, REPLIES)
      }
    },
    /** Advance monotonic time without running callbacks. */
    stall: (ms: number) => {
      clock.now += ms
    },
    /** Advance time with normal timer callbacks. */
    run: (ms: number) => {
      clock.now += ms
      vi.advanceTimersByTime(ms)
    }
  }
  fixtures.push(fixture)
  return fixture
}

function useFakeTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  await waitForPoll()
  await waitForPoll()
  return settled
}

it('accepts an acknowledgment queued behind an overdue warning timer', async () => {
  const { client, onFailure, onSaveDelayChanged, awaitQueuedReply, stall, run } = createClient()
  await client.ready
  useFakeTimers()
  const write = client.writeSerializedDomains([])
  awaitQueuedReply(2)
  // Reproduce resume after hours stalled: expired timers run before queued replies.
  stall(3 * 60 * 60 * 1000)
  run(WARNING_MS)
  expect(await write).toBe(2)
  expect(onSaveDelayChanged.mock.calls).toEqual([[true], [false]])
  await expect(client.writeSerializedDomains([])).resolves.toBe(3)
  expect(onFailure).not.toHaveBeenCalled()
  // Diagnostics must exclude payloads, paths and profile IDs.
  expect(diagnostics.slow).toHaveBeenCalledExactlyOnceWith({
    command: 'write-domains',
    requestId: 1,
    acknowledgedRevision: 1,
    phase: 'awaiting-reply',
    elapsedMs: 3 * 60 * 60 * 1000 + WARNING_MS
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for actual exit after close acknowledgment with one awaiting-exit warning', async () => {
  const fixture = createClient({ holdExit: true })
  const { client, onFailure, run, awaitQueuedReply } = fixture
  await client.ready
  useFakeTimers()
  const closing = client.close()
  // Let the close microtask dispatch before waiting synchronously for its reply.
  await waitForPoll()
  awaitQueuedReply(2)
  await waitForPoll()
  run(WARNING_MS)
  run(WARNING_MS * 2)
  expect(await isSettled(closing)).toBe(false)
  expect(diagnostics.slow).toHaveBeenCalledExactlyOnceWith({
    command: 'close',
    requestId: 1,
    acknowledgedRevision: 1,
    phase: 'awaiting-exit',
    elapsedMs: WARNING_MS
  })
  fixture.releaseExit()
  await expect(closing).resolves.toBeUndefined()
  expect(onFailure).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
