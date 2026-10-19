import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as waitForPoll } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type * as SystemPowerLifecycle from '../../system-power-lifecycle'
import { publishSystemResume, publishSystemSuspend } from '../../system-power-lifecycle'
import type * as WriterDiagnostics from './profile-state-writer-diagnostics'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'

const power = vi.hoisted(() => ({ subscriptions: 0 }))
vi.mock('../../system-power-lifecycle', async (importOriginal) => {
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
const OVERNIGHT_MS = 8 * 60 * 60 * 1000
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

/** A worker whose replies and post-close exit can be held behind shared-memory gates. */
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
  // The fixture worker reads its shared gates from workerData alongside the protocol fields.
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
    /** Hold every reply not yet posted. */
    holdReplies: () => store(ALLOWED_REPLIES, Atomics.load(shared, REPLIES)),
    releaseReplies: () => store(ALLOWED_REPLIES, UNLIMITED),
    releaseExit: () => store(EXIT_ALLOWED, 1),
    /** Block the main thread until the worker has posted reply number `count` (init is 1). */
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
    /** Monotonic time passes while the main loop runs no callbacks. */
    stall: (ms: number) => {
      clock.now += ms
    },
    /** The loop runs normally: timers fire on time. */
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
  // The incident: the loop stalls for hours, then expired timers run before queued messages.
  stall(3 * 60 * 60 * 1000)
  run(WARNING_MS)
  expect(await write).toBe(2)
  expect(onSaveDelayChanged.mock.calls).toEqual([[true], [false]])
  await expect(client.writeSerializedDomains([])).resolves.toBe(3)
  expect(onFailure).not.toHaveBeenCalled()
  // Only codes, counters, and timings: no payloads, paths, or profile ids.
  expect(diagnostics.slow).toHaveBeenCalledExactlyOnceWith({
    command: 'write-domains',
    requestId: 1,
    acknowledgedRevision: 1,
    phase: 'awaiting-reply',
    elapsedMs: 3 * 60 * 60 * 1000 + WARNING_MS
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('clears the warning when the reply arrives first so a stale timer cannot warn', async () => {
  const { client, onFailure, onSaveDelayChanged, run } = createClient()
  await client.ready
  useFakeTimers()
  await expect(client.writeSerializedDomains([])).resolves.toBe(2)
  expect(vi.getTimerCount()).toBe(0)
  run(WARNING_MS * 2)
  expect(diagnostics.slow).not.toHaveBeenCalled()
  expect(onFailure).not.toHaveBeenCalled()
  expect(onSaveDelayChanged).not.toHaveBeenCalled()
})

it('keeps initialization pending past the warning and admits the same worker', async () => {
  useFakeTimers()
  const { client, onFailure, onSaveDelayChanged, run, releaseReplies, workerStarts } = createClient(
    {
      holdReplies: true
    }
  )
  run(WARNING_MS * 3)
  expect(await isSettled(client.ready)).toBe(false)
  releaseReplies()
  await expect(client.ready).resolves.toBeUndefined()
  await expect(client.writeSerializedDomains([])).resolves.toBe(2)
  expect(diagnostics.slow).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ command: 'initialize', requestId: 0, phase: 'awaiting-reply' })
  )
  expect(workerStarts()).toBe(1)
  expect(onFailure).not.toHaveBeenCalled()
  expect(onSaveDelayChanged).not.toHaveBeenCalled()
})

it.each([
  ['write-domains', (client: ProfileStateWriteWorkerClient) => client.writeSerializedDomains([])],
  [
    'write-state',
    (client: ProfileStateWriteWorkerClient) => client.writeSerializedState(Buffer.from('{}'))
  ],
  [
    'write-complete',
    (client: ProfileStateWriteWorkerClient) => client.writeCompleteSerializedDomains([])
  ],
  [
    'write-automation',
    (client: ProfileStateWriteWorkerClient) => client.writeSerializedAutomationRuns([], [])
  ],
  ['assert-revision', (client: ProfileStateWriteWorkerClient) => client.assertCurrentRevision()],
  [
    'export-json',
    (client: ProfileStateWriteWorkerClient, root: string) =>
      client.writeJsonExport(join(root, 'export.json'))
  ],
  [
    'export-latest',
    (client: ProfileStateWriteWorkerClient, root: string) =>
      client.writeLatestJsonExport(join(root, 'export.json'))
  ]
])(
  'accepts a delayed %s reply after the warning and keeps the same worker',
  async (command, start) => {
    const fixture = createClient()
    const { client, onFailure, onSaveDelayChanged, root, run, workerStarts } = fixture
    await client.ready
    useFakeTimers()
    fixture.holdReplies()
    const pending = start(client, root)
    run(WARNING_MS * 3)
    expect(await isSettled(pending)).toBe(false)
    expect(onSaveDelayChanged).toHaveBeenCalledExactlyOnceWith(true)
    expect(() => client.assertWritable()).toThrow(
      expect.objectContaining({ code: 'profile-state-writer-busy' })
    )
    fixture.releaseReplies()
    expect(await pending).toBeGreaterThanOrEqual(1)
    expect(diagnostics.slow).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ command, requestId: 1, phase: 'awaiting-reply' })
    )
    await expect(client.writeSerializedDomains([])).resolves.toBeGreaterThan(1)
    expect(workerStarts()).toBe(1)
    expect(onFailure).not.toHaveBeenCalled()
    expect(onSaveDelayChanged.mock.calls).toEqual([[true], [false]])
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('warns once for a never-replying request without faulting or replacing the worker', async () => {
  const fixture = createClient()
  const { client, onFailure, onSaveDelayChanged, run, workerStarts } = fixture
  await client.ready
  useFakeTimers()
  fixture.holdReplies()
  const write = client.writeSerializedDomains([])
  for (let window = 0; window < 10; window += 1) {
    run(WARNING_MS)
  }
  run(OVERNIGHT_MS)
  expect(await isSettled(write)).toBe(false)
  expect(diagnostics.slow).toHaveBeenCalledOnce()
  expect(onFailure).not.toHaveBeenCalled()
  expect(onSaveDelayChanged).toHaveBeenCalledExactlyOnceWith(true)
  expect(workerStarts()).toBe(1)
  expect(vi.getTimerCount()).toBe(0)
  // Explicit abort keeps the existing fault path and its exit wait.
  const rejected = expect(write).rejects.toMatchObject({
    code: 'profile-state-writer-aborted',
    outcome: 'indeterminate'
  })
  const aborting = client.abort()
  fixture.releaseReplies()
  await aborting
  await rejected
  expect(diagnostics.slow).toHaveBeenCalledOnce()
  expect(onSaveDelayChanged.mock.calls).toEqual([[true], [false]])
})

it('keeps saving if the delayed-save observer throws and clears each delayed request', async () => {
  const fixture = createClient()
  const { client, onSaveDelayChanged, onFailure, run } = fixture
  await client.ready
  useFakeTimers()
  onSaveDelayChanged.mockImplementation(() => {
    throw new Error('renderer unavailable')
  })
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (let revision = 2; revision <= 3; revision += 1) {
      fixture.holdReplies()
      const write = client.writeSerializedDomains([])
      run(WARNING_MS)
      fixture.releaseReplies()
      expect(await write).toBe(revision)
    }
    expect(onSaveDelayChanged.mock.calls).toEqual([[true], [false], [true], [false]])
    expect(onFailure).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    consoleError.mockRestore()
  }
})

it('keeps saving when the diagnostics sink throws', async () => {
  const fixture = createClient()
  const { client, onFailure, run } = fixture
  await client.ready
  useFakeTimers()
  diagnostics.slow.mockImplementationOnce(() => {
    throw new Error('sink unavailable')
  })
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    fixture.holdReplies()
    const write = client.writeSerializedDomains([])
    run(WARNING_MS)
    fixture.releaseReplies()
    expect(await write).toBe(2)
    await expect(client.writeSerializedDomains([])).resolves.toBe(3)
    expect(onFailure).not.toHaveBeenCalled()
    expect(consoleError).toHaveBeenCalledOnce()
  } finally {
    consoleError.mockRestore()
  }
})

it.each(['before sleep', 'during sleep'])(
  'accepts a save started %s across an overnight suspend without power subscriptions',
  async (timing) => {
    const fixture = createClient()
    const { client, onFailure, stall, run } = fixture
    await client.ready
    useFakeTimers()
    if (timing === 'during sleep') {
      publishSystemSuspend()
    }
    fixture.holdReplies()
    const write = client.writeSerializedDomains([{ domain: 'settings', payload: '{}' }])
    publishSystemSuspend()
    stall(OVERNIGHT_MS)
    run(WARNING_MS)
    publishSystemResume()
    run(WARNING_MS)
    expect(await isSettled(write)).toBe(false)
    fixture.releaseReplies()
    expect(await write).toBe(2)
    await expect(client.assertCurrentRevision()).resolves.toBe(2)
    await expect(client.writeSerializedDomains([])).resolves.toBe(3)
    expect(onFailure).not.toHaveBeenCalled()
    expect(diagnostics.slow).toHaveBeenCalledOnce()
    expect(power.subscriptions).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  }
)

it('keeps close pending past the warning until its delayed acknowledgment and exit', async () => {
  const fixture = createClient()
  const { client, onFailure, run } = fixture
  await client.ready
  useFakeTimers()
  fixture.holdReplies()
  const closing = client.close()
  await waitForPoll()
  run(WARNING_MS * 3)
  expect(await isSettled(closing)).toBe(false)
  fixture.releaseReplies()
  await expect(closing).resolves.toBeUndefined()
  expect(diagnostics.slow).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ command: 'close', phase: 'awaiting-reply' })
  )
  expect(onFailure).not.toHaveBeenCalled()
})

it('waits for actual exit after close acknowledgment with one awaiting-exit warning', async () => {
  const fixture = createClient({ holdExit: true })
  const { client, onFailure, run, awaitQueuedReply } = fixture
  await client.ready
  useFakeTimers()
  const closing = client.close()
  // close() dispatches after a microtask; let it post before blocking on the reply.
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
