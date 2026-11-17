import { afterEach, expect, it, vi } from 'vitest'
import { JournalSqlActivity } from './journal-sql-activity'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import type { JournalSqlMaintenance } from './journal-sql-maintenance'

afterEach(() => {
  vi.useRealTimers()
})

it('keeps periodic cleanup running while a retirement proof waits on a paused conversion', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const checks: string[] = []
  const activity = new JournalSqlActivity()
  const maintenance = new JournalSqlBackgroundMaintenance(
    {
      maintain: async (operation: JournalSqlMaintenance) => {
        checks.push(operation.kind)
        return operation.kind === 'compaction-state'
          ? { kind: 'compaction-state', completedAt: Date.now() }
          : { kind: 'page-reclaim', more: false }
      }
    },
    {
      database: async (operation) =>
        operation.kind === 'forgotten-chats'
          ? { kind: 'forgotten-chats', sessionIds: [] }
          : { kind: 'retired-heads', heads: [], through: null }
    },
    { ensure: async () => null },
    activity,
    (error) => {
      throw error
    }
  )
  // A live chat pauses the proof's conversion; it settles only once that chat goes idle.
  const release = activity.hold()
  const conversion = Promise.withResolvers<string>()
  const waiting = maintenance.serviceWhile(conversion.promise)
  void maintenance.start()
  const compactionChecks = () => checks.filter((kind) => kind === 'compaction-state').length
  for (let minute = 0; minute < 10; minute++) {
    await vi.advanceTimersByTimeAsync(60_000)
    // Maintenance yields through real setImmediate turns between its units.
    for (let turn = 0; turn < 20; turn++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  // Every periodic tick runs while the conversion stays paused.
  expect(compactionChecks()).toBe(10)
  conversion.resolve('epoch')
  await expect(waiting).resolves.toBe('epoch')
  maintenance.stop()
  release()
})
