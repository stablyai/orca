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

it('runs a sending chat ahead of bulk, lifts its queued write when it starts sending, and closes last', () => {
  const queue = new JournalSqlWriterQueue()
  queue.push(write(1, 'streaming'))
  queue.push(write(2, 'sending'))
  queue.push({ id: 3, command: { type: 'close' } })
  expect(queue.promote('idle')).toBe(false)
  expect(queue.promote('sending')).toBe(true)
  queue.push(write(4, 'other-send', true))
  const drained = Array.from({ length: 4 }, () => ids(queue.take())[0])
  expect(drained).toEqual([2, 4, 1, 3])
})
