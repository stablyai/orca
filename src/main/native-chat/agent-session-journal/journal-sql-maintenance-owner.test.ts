import { afterEach, expect, it, vi } from 'vitest'
import { JournalSqlActivity } from './journal-sql-activity'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import type { JournalSqlMaintenance } from './journal-sql-maintenance'
import type { JournalSqlDatabaseRead } from './journal-sql-database-read'

afterEach(() => {
  vi.useRealTimers()
})

it('keeps periodic cleanup running while a retirement proof waits on a paused conversion', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const checks: string[] = []
  const errors: unknown[] = []
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
      database: async (operation: JournalSqlDatabaseRead) =>
        operation.kind === 'forgotten-chats'
          ? { kind: 'forgotten-chats', sessionIds: [] }
          : operation.kind === 'sessions'
            ? { kind: 'sessions', sessionIds: [] }
            : { kind: 'retired-heads', heads: [], through: null }
    },
    { ensure: async () => null, compareLegacyChats: async () => {} },
    activity,
    (error) => errors.push(error)
  )
  // As in production, the retirement runs inside the maintenance loop and its proof waits on a
  // conversion that a live chat pauses; only servicing inside that wait keeps cleanup going.
  const release = activity.hold()
  const conversion = Promise.withResolvers<string>()
  let proofWait: Promise<string> | undefined
  maintenance.legacy = {
    run: async () => {
      proofWait ??= maintenance.serviceWhile(conversion.promise)
      await proofWait
    }
  }
  void maintenance.start()
  const compactionChecks = () => checks.filter((kind) => kind === 'compaction-state').length
  for (let minute = 0; minute < 10; minute++) {
    await vi.advanceTimersByTimeAsync(60_000)
    // Maintenance yields through real setImmediate turns between its units.
    for (let turn = 0; turn < 20; turn++) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  expect(compactionChecks()).toBe(10)
  conversion.resolve('epoch')
  await expect(proofWait).resolves.toBe('epoch')
  maintenance.stop()
  await maintenance.settled()
  release()
  expect(errors).toEqual([])
})
