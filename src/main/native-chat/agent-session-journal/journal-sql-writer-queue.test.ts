import { expect, it } from 'vitest'
import type { JournalSqlRequest } from './journal-sql-protocol'
import { JournalSqlWriterQueue } from './journal-sql-writer-queue'

const write = (id: number, sessionId: string, urgent = false): JournalSqlRequest => ({
  id,
  ...(urgent ? { urgent: true as const } : {}),
  command: {
    type: 'write',
    command: {
      target: { sessionId, epoch: 'epoch', ownerToken: 'owner' },
      operation: {
        kind: 'tombstone',
        identity: { provider: 'orca', clientMessageId: 'x' },
        fence: 1
      }
    }
  }
})
const ids = (requests: JournalSqlRequest[]) => requests.map((request) => request.id)

it('runs a sending chat ahead of bulk, gives bulk a turn after eight urgent drains, and closes last', () => {
  const queue = new JournalSqlWriterQueue()
  queue.push(write(1, 'streaming'))
  queue.push(write(2, 'sending'))
  expect(queue.promote('idle')).toBe(false)
  expect(queue.promote('sending')).toBe(true)
  expect(ids(queue.take(true))).toEqual([2])

  for (let id = 10; id < 19; id++) {
    queue.push(write(id, `chat-${id}`, true))
  }
  const drained = Array.from({ length: 10 }, () => ids(queue.take(true))[0])
  expect(drained).toEqual([10, 11, 12, 13, 14, 15, 16, 1, 17, 18])

  queue.push({ id: 30, command: { type: 'close' } })
  for (let id = 20; id < 29; id++) {
    queue.push(write(id, `chat-${id}`, true))
  }
  const closing = Array.from({ length: 10 }, () => ids(queue.take(true))[0])
  expect(closing).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 30])
})

it('keeps urgent work first while the WAL refuses bulk', () => {
  const queue = new JournalSqlWriterQueue()
  queue.push(write(1, 'streaming'))
  for (let id = 2; id < 12; id++) {
    queue.push(write(id, `chat-${id}`, true))
  }
  const drained = Array.from({ length: 11 }, () => ids(queue.take(false))[0])
  expect(drained).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 1])
})
