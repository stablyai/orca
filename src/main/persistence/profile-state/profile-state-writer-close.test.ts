import { setImmediate as waitForPoll } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'

const fixture = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  class Worker extends EventEmitter {
    static instances: Worker[] = []
    acknowledgeClose = true
    terminate = vi.fn(() => new Promise<number>(() => {}))
    constructor() {
      super()
      Worker.instances.push(this)
      queueMicrotask(() => this.emit('message', { id: 0, ok: true, revision: 1 }))
    }
    postMessage(request: { id: number }) {
      if (this.acknowledgeClose) {
        queueMicrotask(() => this.emit('message', { id: request.id, ok: true, revision: 1 }))
      }
    }
  }
  return { Worker }
})
vi.mock('node:worker_threads', () => ({ Worker: fixture.Worker }))
const diagnostics = vi.hoisted(() => ({ slow: vi.fn() }))
vi.mock('./profile-state-writer-diagnostics', () => ({
  recordProfileStateWriterFault: vi.fn(),
  recordProfileStateWriterSlow: diagnostics.slow
}))

const clients: ProfileStateWriteWorkerClient[] = []
const WARNING_MS = 30_000

afterEach(async () => {
  for (const worker of fixture.Worker.instances.splice(0)) {
    worker.emit('exit', 1)
  }
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  vi.useRealTimers()
  diagnostics.slow.mockReset()
})

async function createClient() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const onFailure = vi.fn()
  const client = new ProfileStateWriteWorkerClient(
    { databasePath: 'unused.db', profileId: 'close-test', revision: 1 },
    { workerPath: 'unused.cjs', slowWarningMs: WARNING_MS, onFailure }
  )
  clients.push(client)
  await client.ready
  const worker = fixture.Worker.instances.at(-1)
  if (!worker) {
    throw new Error('Writer was not created')
  }
  return { client, worker, onFailure }
}

async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  await waitForPoll()
  return settled
}

it('holds an acknowledged close until actual exit without terminating the worker', async () => {
  const { client, worker, onFailure } = await createClient()
  const closing = client.close()
  await waitForPoll()
  vi.advanceTimersByTime(WARNING_MS * 10)
  expect(await isSettled(closing)).toBe(false)
  expect(worker.terminate).not.toHaveBeenCalled()
  expect(diagnostics.slow).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ command: 'close', phase: 'awaiting-exit' })
  )
  worker.emit('exit', 0)
  await expect(closing).resolves.toBeUndefined()
  expect(onFailure).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps an unacknowledged close pending, then holds abort until the terminated worker exits', async () => {
  const { client, worker, onFailure } = await createClient()
  worker.acknowledgeClose = false
  const closing = client.close().catch((error: unknown) => error)
  await waitForPoll()
  vi.advanceTimersByTime(WARNING_MS * 10)
  expect(await isSettled(closing)).toBe(false)
  expect(worker.terminate).not.toHaveBeenCalled()
  expect(onFailure).not.toHaveBeenCalled()
  expect(diagnostics.slow).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ command: 'close', phase: 'awaiting-reply' })
  )
  const aborting = client.abort()
  expect(worker.terminate).toHaveBeenCalledOnce()
  // A termination request is not proof of exit.
  vi.advanceTimersByTime(WARNING_MS * 10)
  expect(await isSettled(aborting)).toBe(false)
  expect(await isSettled(closing)).toBe(false)
  worker.emit('exit', 1)
  await aborting
  expect(await closing).toMatchObject({ code: 'profile-state-writer-aborted' })
  expect(onFailure).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('completes a clean close only after the acknowledged worker exits', async () => {
  const { client, worker, onFailure } = await createClient()
  let settled = false
  const closing = client.close().then(() => (settled = true))
  await waitForPoll()
  expect(settled).toBe(false)
  worker.emit('exit', 0)
  await closing
  expect(worker.terminate).not.toHaveBeenCalled()
  expect(onFailure).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('joins an aborted writer without reporting a close request that was never sent', async () => {
  const { client, worker } = await createClient()
  const aborting = client.abort()
  const closing = client.close()
  await waitForPoll()
  vi.advanceTimersByTime(WARNING_MS * 10)
  expect(await isSettled(closing)).toBe(false)
  expect(diagnostics.slow).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  worker.emit('exit', 1)
  await aborting
  await closing
})
