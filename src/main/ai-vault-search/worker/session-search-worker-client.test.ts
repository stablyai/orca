import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { SessionSearchWorkerClient } from './session-search-worker-client'
import type { SearchWorkerRequest } from './session-search-worker-protocol'

class UnansweredWorker extends EventEmitter {
  readonly received: SearchWorkerRequest[] = []
  unref(): void {}
  postMessage(request: SearchWorkerRequest): void {
    this.received.push(request)
  }
  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
  answerAll(): void {
    for (const { id } of this.received.splice(0)) {
      this.emit('message', { id })
    }
  }
}

it('holds writer commands past the in-flight cap and sends them in order once the worker answers', async () => {
  const worker = new UnansweredWorker()
  const client = new SessionSearchWorkerClient(undefined, () => worker, true)
  const replies = Array.from({ length: 1100 }, (_, index) =>
    client.request({ op: 'remove', path: `/sessions/${index}.jsonl` })
  )
  expect(worker.received).toHaveLength(1024)
  worker.answerAll()
  expect(worker.received.map(({ command }) => command)).toEqual(
    Array.from({ length: 76 }, (_, index) => ({
      op: 'remove',
      path: `/sessions/${1024 + index}.jsonl`
    }))
  )
  worker.answerAll()
  await expect(Promise.all(replies)).resolves.toHaveLength(1100)
})
