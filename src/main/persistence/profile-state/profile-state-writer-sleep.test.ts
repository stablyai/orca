import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as SystemPowerLifecycle from '../../system-power-lifecycle'
import { publishSystemResume, publishSystemSuspend } from '../../system-power-lifecycle'
import {
  PROFILE_STATE_WRITER_MAX_GRACES,
  PROFILE_STATE_WRITER_OVERDUE_GRACE_MS
} from './profile-state-writer-deadline'
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

const clients: ProfileStateWriteWorkerClient[] = []
const roots: string[] = []
const TIMEOUT_MS = 30_000
const OVERNIGHT_MS = 8 * 60 * 60 * 1000

afterEach(async () => {
  vi.useRealTimers()
  publishSystemResume()
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** A worker that counts replies in shared memory, so a test can block until one is queued. */
function createClient({ acknowledgeWrites = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-writer-sleep-'))
  roots.push(root)
  const workerPath = join(root, 'writer.cjs')
  writeFileSync(
    workerPath,
    `
    const { parentPort, workerData } = require('node:worker_threads')
    const replies = new Int32Array(workerData.replies)
    let revision = 1
    parentPort.postMessage({ id: 0, ok: true, revision })
    parentPort.on('message', request => {
      if (request.command.startsWith('write-')) {
        if (!workerData.acknowledgeWrites) return
        revision++
      }
      parentPort.postMessage({ id: request.id, ok: true, revision })
      Atomics.add(replies, 0, 1)
      Atomics.notify(replies, 0)
      if (request.command === 'close') parentPort.close()
    })
    `
  )
  const replies = new SharedArrayBuffer(4)
  const initialization = {
    databasePath: join(root, 'unused.db'),
    profileId: 'sleep-test',
    revision: 1,
    replies,
    acknowledgeWrites
  }
  const clock = { now: 0 }
  const onFailure = vi.fn()
  const client = new ProfileStateWriteWorkerClient(initialization, {
    workerPath,
    onFailure,
    clock: () => clock.now
  })
  clients.push(client)
  const counter = new Int32Array(replies)
  return {
    client,
    onFailure,
    /** Block the main thread until the worker has posted reply number `count`. */
    awaitQueuedReply: (count: number) => {
      while (Atomics.load(counter, 0) < count) {
        Atomics.wait(counter, 0, Atomics.load(counter, 0), 5_000)
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
}

it('accepts an acknowledgment queued behind an overdue timeout with no power events', async () => {
  const { client, onFailure, awaitQueuedReply, stall, run } = createClient()
  await client.ready
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const write = client.writeSerializedDomains([]).catch((error: unknown) => error)
  awaitQueuedReply(1)
  // The incident: the loop stalls for hours, then expired timers run before queued messages.
  stall(3 * 60 * 60 * 1000)
  run(TIMEOUT_MS)
  expect(await write).toBe(2)
  await expect(client.writeSerializedDomains([])).resolves.toBe(3)
  expect(onFailure).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it.each([0, 1, PROFILE_STATE_WRITER_OVERDUE_GRACE_MS - 1])(
  'keeps saving across repeated queued replies when the timeout is %i ms overdue',
  async (overdueMs) => {
    const { client, onFailure, awaitQueuedReply, stall, run } = createClient()
    await client.ready
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    for (let writeNumber = 1; writeNumber <= 4; writeNumber += 1) {
      const write = client.writeSerializedDomains([]).catch((error: unknown) => error)
      awaitQueuedReply(writeNumber)
      stall(overdueMs)
      run(TIMEOUT_MS)
      expect(await write).toBe(writeNumber + 1)
      expect(vi.getTimerCount()).toBe(0)
      expect(power.subscriptions).toBe(0)
    }
    expect(onFailure).not.toHaveBeenCalled()
  }
)

it('accepts a reply delivered before its timeout and releases the deadline', async () => {
  const { client, onFailure } = createClient()
  await client.ready
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await expect(client.writeSerializedDomains([])).resolves.toBe(2)
  expect(vi.getTimerCount()).toBe(0)
  expect(power.subscriptions).toBe(0)
  expect(onFailure).not.toHaveBeenCalled()
})

it.each(['before sleep', 'during sleep'])(
  'accepts a save started %s across an overnight suspend and keeps saving',
  async (timing) => {
    const { client, onFailure, awaitQueuedReply, stall, run } = createClient()
    await client.ready
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    if (timing === 'during sleep') {
      publishSystemSuspend()
    }
    const write = client
      .writeSerializedDomains([{ domain: 'settings', payload: '{}' }])
      .catch((error: unknown) => error)
    awaitQueuedReply(1)
    publishSystemSuspend()
    stall(OVERNIGHT_MS)
    run(TIMEOUT_MS)
    publishSystemResume()
    expect(await write).toBe(2)
    await expect(client.assertCurrentRevision()).resolves.toBe(2)
    await expect(client.writeSerializedDomains([])).resolves.toBe(3)
    expect(onFailure).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(power.subscriptions).toBe(0)
  }
)

it('saves during a dark wake that never publishes resume', async () => {
  const { client, onFailure, awaitQueuedReply, run } = createClient()
  await client.ready
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  publishSystemSuspend()
  const write = client.writeSerializedDomains([]).catch((error: unknown) => error)
  awaitQueuedReply(1)
  // The loop runs on time while power state still reads suspended.
  run(TIMEOUT_MS)
  expect(await write).toBe(2)
  await expect(client.writeSerializedDomains([])).resolves.toBe(3)
  expect(onFailure).not.toHaveBeenCalled()
})

it('allows initialization during suspend without retiring the writer', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  publishSystemSuspend()
  const { client, stall, run } = createClient()
  const ready = client.ready.catch((error: unknown) => error)
  stall(OVERNIGHT_MS)
  run(TIMEOUT_MS)
  publishSystemResume()
  expect(await ready).toBeUndefined()
  expect(() => client.assertWritable()).not.toThrow()
})

it('still retires a hung writer once the loop runs a full window on time after grace', async () => {
  const { client, onFailure, stall, run } = createClient({ acknowledgeWrites: false })
  await client.ready
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const write = client.writeSerializedDomains([]).catch((error: unknown) => error)
  stall(3 * 60 * 60 * 1000)
  run(TIMEOUT_MS)
  run(TIMEOUT_MS - 1)
  expect(onFailure).not.toHaveBeenCalled()
  run(1)
  expect(await write).toMatchObject({
    code: 'profile-state-writer-timeout',
    outcome: 'indeterminate'
  })
  await expect(client.assertCurrentRevision()).rejects.toMatchObject({
    code: 'profile-state-writer-timeout'
  })
  expect(onFailure).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  expect(power.subscriptions).toBe(0)
})

it('still retires a hung writer after its awake deadline following resume', async () => {
  const { client, onFailure, stall, run } = createClient({ acknowledgeWrites: false })
  await client.ready
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const write = client.writeSerializedDomains([]).catch((error: unknown) => error)
  run(TIMEOUT_MS - 1_000)
  publishSystemSuspend()
  stall(OVERNIGHT_MS)
  publishSystemResume()
  run(TIMEOUT_MS - 1)
  expect(onFailure).not.toHaveBeenCalled()
  run(1)
  expect(await write).toMatchObject({ code: 'profile-state-writer-timeout' })
  expect(onFailure).toHaveBeenCalledOnce()
})

it('bounds repeated stalls so a hung writer cannot wait forever', async () => {
  const { client, stall, run } = createClient({ acknowledgeWrites: false })
  await client.ready
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const write = client.writeSerializedDomains([]).catch((error: unknown) => error)
  let settled = false
  void write.then(() => (settled = true))
  for (let episode = 0; episode < PROFILE_STATE_WRITER_MAX_GRACES; episode += 1) {
    stall(60 * 60 * 1000)
    run(TIMEOUT_MS)
    await Promise.resolve()
    expect(settled).toBe(false)
  }
  stall(60 * 60 * 1000)
  run(TIMEOUT_MS)
  expect(await write).toMatchObject({ code: 'profile-state-writer-timeout' })
})

it.each([true, false])(
  'settles after repeated resumes with a queued reply: %s',
  async (acknowledgeWrites) => {
    const { client, onFailure, awaitQueuedReply, run } = createClient({ acknowledgeWrites })
    await client.ready
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const write = client.writeSerializedDomains([]).catch((error: unknown) => error)
    if (acknowledgeWrites) {
      awaitQueuedReply(1)
    }
    for (let cycle = 0; cycle <= PROFILE_STATE_WRITER_MAX_GRACES; cycle += 1) {
      run(TIMEOUT_MS - 1)
      publishSystemSuspend()
      publishSystemResume()
    }
    run(1)
    if (acknowledgeWrites) {
      expect(await write).toBe(2)
      await expect(client.writeSerializedDomains([])).resolves.toBe(3)
      expect(onFailure).not.toHaveBeenCalled()
    } else {
      expect(await write).toMatchObject({ code: 'profile-state-writer-timeout' })
      expect(onFailure).toHaveBeenCalledOnce()
    }
    expect(vi.getTimerCount()).toBe(0)
    expect(power.subscriptions).toBe(0)
  }
)

it('releases deadlines and power subscriptions after abort and close', async () => {
  const aborted = createClient({ acknowledgeWrites: false })
  await aborted.client.ready
  const pending = aborted.client.writeSerializedDomains([]).catch((error: unknown) => error)
  expect(power.subscriptions).toBe(1)
  await aborted.client.abort()
  expect(await pending).toMatchObject({ code: 'profile-state-writer-aborted' })
  expect(power.subscriptions).toBe(0)

  const closed = createClient()
  await closed.client.ready
  await closed.client.close()
  expect(power.subscriptions).toBe(0)
})
