import { EventEmitter } from 'node:events'
import { vi } from 'vitest'

type SentMessage = { op: string; id: number; dir?: string }

export class FakeWatcherChild extends EventEmitter {
  connected = true
  pid = 1234
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  sent: SentMessage[] = []
  stderr = new EventEmitter()
  kill = vi.fn(() => {
    this.connected = false
  })
  send = vi.fn((message: SentMessage) => {
    this.sent.push(message)
    return true
  })
}

export function currentWatcherChild(forkMock: ReturnType<typeof vi.fn>): FakeWatcherChild {
  const result = forkMock.mock.results.at(-1)
  if (!result) {
    throw new Error('fork was not called')
  }
  return result.value as FakeWatcherChild
}

export function acknowledgeWatcherSubscribe(child: FakeWatcherChild, index = -1): number {
  const message = child.sent.filter((candidate) => candidate.op === 'subscribe').at(index)
  if (!message) {
    throw new Error('no subscribe message sent')
  }
  child.emit('message', { op: 'subscribed', id: message.id })
  return message.id
}

export function trackPromiseSettlement(promise: Promise<unknown>): () => boolean {
  let settled = false
  void promise.then(
    () => (settled = true),
    () => (settled = true)
  )
  return () => settled
}
