import { EventEmitter, getEventListeners } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { expect, it, vi } from 'vitest'
import { OpenCodeSqliteWorkerClient } from './session-scanner-opencode-sqlite-worker-client'
import {
  withSessionSearchIndexRequired,
  withStreamingSessionSearchCapture
} from './session-search-capture'
import type { OpenCodeSqliteParentMessage } from './session-scanner-opencode-sqlite-worker-protocol'

class TestWorker extends EventEmitter {
  requests: OpenCodeSqliteParentMessage[] = []
  terminate = vi.fn(async () => 0)
  unref(): void {}
  postMessage(request: OpenCodeSqliteParentMessage): void {
    this.requests.push(request)
  }
}
const args = { dbPath: '/isolated/opencode.db', sessionId: 'a', platform: 'linux' as const }

it('cancels a queued parse without terminating the ordinary list ahead of it', async () => {
  const worker = new TestWorker()
  const client = new OpenCodeSqliteWorkerClient({
    workerFactory: () => worker as unknown as Worker
  })
  const list = client.list({ dbPaths: [args.dbPath], limit: 10, issues: [] })
  const controller = new AbortController()
  const parsed = withSessionSearchIndexRequired(() => client.parse(args), controller.signal)
  const rejected = expect(parsed).rejects.toMatchObject({ name: 'AbortError' })
  controller.abort()
  await rejected
  expect(worker.terminate).not.toHaveBeenCalled()
  expect(worker.requests).toHaveLength(1)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  worker.emit('message', {
    id: worker.requests[0].id,
    kind: 'result',
    value: { candidates: [], issues: [] }
  })
  expect(await list).toEqual([])
})

it('cancels during backpressure without a late ack and allows the queued list to finish', async () => {
  const workers: TestWorker[] = []
  const client = new OpenCodeSqliteWorkerClient({
    workerFactory: () => {
      const worker = new TestWorker()
      workers.push(worker)
      return worker as unknown as Worker
    }
  })
  const controller = new AbortController()
  let release!: () => void
  const drained = new Promise<void>((resolve) => {
    release = resolve
  })
  const checkpoint = vi.fn(() => drained)
  const parsed = withSessionSearchIndexRequired(
    () => withStreamingSessionSearchCapture({ push() {}, checkpoint }, () => client.parse(args)),
    controller.signal
  )
  const rejected = expect(parsed).rejects.toMatchObject({ name: 'AbortError' })
  const list = client.list({ dbPaths: [args.dbPath], limit: 10, issues: [] })
  workers[0].emit('message', {
    id: workers[0].requests[0].id,
    kind: 'batch',
    batch: 1,
    messages: []
  })
  expect(checkpoint).toHaveBeenCalledOnce()
  controller.abort()
  await rejected
  release()
  await drained
  await Promise.resolve()
  expect(workers[0].terminate).toHaveBeenCalledOnce()
  expect(workers[0].requests).toHaveLength(1)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  workers[1].emit('message', {
    id: workers[1].requests[0].id,
    kind: 'result',
    value: { candidates: [], issues: [] }
  })
  expect(await list).toEqual([])
})

it('removes the cancellation listener after success and rejects pre-aborted work before spawning', async () => {
  const worker = new TestWorker()
  const factory = vi.fn(() => worker as unknown as Worker)
  const client = new OpenCodeSqliteWorkerClient({ workerFactory: factory })
  const controller = new AbortController()
  const parsed = withSessionSearchIndexRequired(() => client.parse(args), controller.signal)
  worker.emit('message', { id: worker.requests[0].id, kind: 'result', value: { session: null } })
  expect(await parsed).toBeNull()
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  controller.abort()
  await expect(
    withSessionSearchIndexRequired(() => client.parse(args), controller.signal)
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(factory).toHaveBeenCalledOnce()
  expect(worker.requests).toHaveLength(1)
  expect(worker.terminate).not.toHaveBeenCalled()
})

it('unblocks a local capture checkpoint on abort while an ordinary list still completes after its sink stops', async () => {
  const { captureIndexedSessionParse } = await import('./session-search-indexed-parse')
  const { captureSessionSearchMessage, checkpointSessionSearchCapture } =
    await import('./session-search-capture')
  const controller = new AbortController()
  let produced = 0
  const parse = async () => {
    for (let part = 0; part < 40; part++) {
      produced++
      captureSessionSearchMessage({ role: 'user', text: 'part', timestamp: null })
      await checkpointSessionSearchCapture()
    }
    return { value: 'complete', session: null, byteOffset: 40 }
  }
  const base = {
    candidate: {
      agent: 'opencode' as const,
      codexHome: null,
      file: { path: args.dbPath, mtimeMs: 1, modifiedAt: new Date(1).toISOString() }
    },
    mode: 'replace' as const,
    previousByteOffset: 0
  }
  const sink = {
    indexedFile: () => null,
    markStale() {},
    async apply() {
      controller.abort()
    }
  }
  await expect(
    withSessionSearchIndexRequired(
      () => captureIndexedSessionParse(sink, base, parse),
      controller.signal
    )
  ).rejects.toMatchObject({ name: 'AbortError' })
  expect(produced).toBe(1)
  produced = 0
  expect(await captureIndexedSessionParse(sink, base, parse)).toBe('complete')
  expect(produced).toBe(40)
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})
