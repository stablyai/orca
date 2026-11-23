import { afterEach, describe, expect, it, vi } from 'vitest'
import { JournalConversionStorageError, JournalSqlConversions } from './journal-sql-conversions'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import { JournalSqlActivity } from './journal-sql-activity'
import type { JournalSqlConversionReader, JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalConversionStorage } from './journal-conversion-storage'
import type { JournalSqlMaintenanceResult } from './journal-sql-maintenance'

const GB = 1024 ** 3
const ROOM = { freeBytes: 60 * GB, totalBytes: 100 * GB, remainingBytes: 20 * GB }
// 20 GB free can't hold 1.5x a 20 GB original above the 10 GB floor.
const LOW = { freeBytes: 20 * GB, totalBytes: 100 * GB, remainingBytes: 20 * GB }

afterEach(() => {
  vi.restoreAllMocks()
})

function conversion(
  storage: () => JournalConversionStorage | null | Promise<JournalConversionStorage | null>,
  pages = 1,
  sessionIds = ['chat']
) {
  const writes: string[] = []
  const readers: Pick<
    JournalSqlReaderPool,
    'database' | 'compareLegacyChat' | 'importState' | 'prepareConversion' | 'conversionStorage'
  > = {
    database: async (read) =>
      read.kind === 'retired-heads'
        ? { kind: 'retired-heads', heads: [], through: null }
        : read.kind === 'forgotten-chats'
          ? { kind: 'forgotten-chats', sessionIds: [] }
          : {
              kind: 'sessions',
              sessionIds: read.kind === 'sessions' && !read.after ? sessionIds : []
            },
    compareLegacyChat: async () => null,
    importState: async () => ({ state: 'converting', epoch: null }),
    prepareConversion: async (sessionId) => {
      let read = 0
      const reader = {
        header: { sessionId, workspaceId: 'workspace', epoch: 'epoch' },
        next: async () => (read++ < pages ? { kind: 'items' as const, rows: [] } : null),
        close: async () => {}
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: conversions use only header, next and close.
      return reader as unknown as JournalSqlConversionReader
    },
    conversionStorage: async () => storage()
  }
  const writer = {
    maintain: async (operation: { kind: string }): Promise<JournalSqlMaintenanceResult> => {
      writes.push(operation.kind)
      if (operation.kind === 'import-discard') {
        return { more: false, epoch: null }
      }
      if (operation.kind === 'import-page') {
        return true
      }
      if (operation.kind === 'import-finish') {
        return 'epoch'
      }
      // Idle upkeep finds nothing to do.
      return operation.kind === 'compaction-state'
        ? { kind: 'compaction-state', completedAt: Date.now() }
        : { more: false, epoch: null }
    }
  }
  const conversions = new JournalSqlConversions(writer, readers, async () => {})
  return { conversions, writes, readers, writer }
}

const deferred = expect.any(JournalConversionStorageError)

describe('JournalSqlConversions storage guard', () => {
  it('the idle sweep converts nothing below the floor, and every chat once space frees', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let storage = LOW
    const { conversions, writes, readers, writer } = conversion(() => storage, 1, ['a', 'b'])
    const errors: unknown[] = []
    const maintenance = new JournalSqlBackgroundMaintenance(
      writer,
      readers,
      conversions,
      new JournalSqlActivity(),
      (error) => errors.push(error)
    )
    await maintenance.start()
    expect(writes).not.toContain('import-page')
    expect(errors).toEqual([deferred])
    storage = ROOM
    // The periodic tick after the backoff starts the sweep over.
    await vi.advanceTimersByTimeAsync(60_000)
    await maintenance.settled()
    maintenance.stop()
    vi.useRealTimers()
    expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(2)
    expect(errors).toEqual([deferred])
  })

  it('stops a big chat between batches once free space reaches the floor', async () => {
    let checks = 0
    const { conversions, writes } = conversion(
      () => (checks++ < 3 ? ROOM : { freeBytes: 4 * GB, totalBytes: 100 * GB }),
      10
    )
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes.filter((kind) => kind === 'import-page')).toHaveLength(2)
    expect(writes).not.toContain('import-finish')
  })

  it.each([
    ['low space', () => LOW],
    ['a failed measure', () => null]
  ])('after %s, the retry measures again and resumes once space frees', async (_, first) => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let measure: () => JournalConversionStorage | null = first
    const { conversions, writes } = conversion(() => measure())
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    measure = () => ROOM
    // Inside the backoff nothing is attempted.
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes).toEqual(['import-discard'])
    now += 60_000
    await expect(conversions.ensure('chat', false)).resolves.toBe('epoch')
    expect(writes).toContain('import-finish')
  })

  it('an open converts its chat below the floor, even while background conversion is deferred', async () => {
    const { conversions, writes } = conversion(() => ({ freeBytes: GB, totalBytes: 100 * GB }), 3)
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    await expect(conversions.ensure('chat')).resolves.toBe('epoch')
    expect(writes.filter((kind) => kind === 'import-page')).toHaveLength(3)
    expect(writes).toContain('import-finish')
  })

  it('an open that joins a background conversion waiting on its measure still converts', async () => {
    let answer: (storage: JournalConversionStorage) => void = () => {}
    const measured = new Promise<JournalConversionStorage>((resolve) => (answer = resolve))
    const { conversions, writes } = conversion(() => measured)
    const background = conversions.ensure('chat', false)
    const opened = conversions.ensure('chat')
    answer(LOW)
    await expect(opened).resolves.toBe('epoch')
    await expect(background).resolves.toBe('epoch')
    expect(writes).toContain('import-finish')
  })

  it('a source the measure cannot read fails as that source, not as low space', async () => {
    const corrupt = new Error('database disk image is malformed')
    const { conversions } = conversion(() => {
      throw corrupt
    })
    await expect(conversions.ensure('chat', false)).rejects.toBe(corrupt)
    expect(conversions.deferred()).toBe(false)
  })
})
