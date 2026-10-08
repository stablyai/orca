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
vi.mock('./profile-state-writer-diagnostics', () => ({
  recordProfileStateWriterFault: vi.fn(),
  recordProfileStateWriterGrace: vi.fn(),
  recordProfileStateWriterTimeout: vi.fn()
}))

const clients: ProfileStateWriteWorkerClient[] = []
const TIMEOUT_MS = 30_000

afterEach(async () => {
  for (const worker of fixture.Worker.instances.splice(0)) {
    worker.emit('exit', 1)
  }
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  vi.useRealTimers()
})

async function createClient() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const onFailure = vi.fn()
  const client = new ProfileStateWriteWorkerClient(
    { databasePath: 'unused.db', profileId: 'close-test', revision: 1 },
    { workerPath: 'unused.cjs', timeoutMs: TIMEOUT_MS, onFailure }
  )
  clients.push(client)
  await client.ready
  const worker = fixture.Worker.instances.at(-1)
  if (!worker) {
    throw new Error('Writer was not created')
  }
  return { client, worker, onFailure }
}

it.each([true, false])(
  'keeps close pending until the terminated worker exits (acknowledged: %s)',
  async (acknowledged) => {
    const { client, worker } = await createClient()
    worker.acknowledgeClose = acknowledged
    let settled = false
    const closing = client
      .close()
      .catch((error: unknown) => error)
      .finally(() => (settled = true))
    await waitForPoll()
    vi.advanceTimersByTime(TIMEOUT_MS)
    await waitForPoll()
    await waitForPoll()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(settled).toBe(false)
    worker.emit('exit', 1)
    expect(await closing).toMatchObject({
      code: acknowledged ? 'profile-state-writer-close-timeout' : 'profile-state-writer-timeout'
    })
    expect(vi.getTimerCount()).toBe(0)
  }
)

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
