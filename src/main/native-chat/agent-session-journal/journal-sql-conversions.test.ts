import { afterEach, describe, expect, it, vi } from 'vitest'
import { JournalConversionStorageError, JournalSqlConversions } from './journal-sql-conversions'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import { JournalSqlActivity } from './journal-sql-activity'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalConversionStorage } from './journal-conversion-storage'

const GB = 1024 ** 3
const ROOM = { freeBytes: 60 * GB, totalBytes: 100 * GB, remainingBytes: 20 * GB }
// 20 GB free can't hold 1.5x a 20 GB original above the 10 GB floor.
const LOW = { freeBytes: 20 * GB, totalBytes: 100 * GB, remainingBytes: 20 * GB }

afterEach(() => {
  vi.restoreAllMocks()
})

function conversion(storage: () => JournalConversionStorage, pages = 1, sessionIds = ['chat']) {
  const writes: string[] = []
  const readers = {
    database: async ({ kind, after }: { kind: string; after: string | null }) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the sweep reads only these three page kinds.
      kind === 'retired-heads'
        ? { kind, heads: [], through: null }
        : { kind, sessionIds: kind === 'sessions' && after === null ? sessionIds : [] },
    compareLegacyChat: async () => null,
    importState: async () => ({ state: 'converting' as const, epoch: null }),
    prepareConversion: async (sessionId: string) => {
      let read = 0
      return {
        header: { sessionId, workspaceId: 'workspace', epoch: 'epoch' },
        next: async () => (read++ < pages ? { kind: 'items' as const, rows: [] } : null),
        close: async () => {}
      }
    },
    conversionStorage: async () => storage()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this focused fixture only reaches conversion calls.
  } as unknown as Pick<
    JournalSqlReaderPool,
    'database' | 'compareLegacyChat' | 'importState' | 'prepareConversion' | 'conversionStorage'
  >
  const writer = {
    maintain: async (operation: { kind: string }) => {
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
      throw new Error(`unexpected ${operation.kind}`)
    }
  }
  const conversions = new JournalSqlConversions(writer, readers, async () => {})
  return { conversions, writes, readers, writer }
}

const deferred = expect.any(JournalConversionStorageError)

describe('JournalSqlConversions storage guard', () => {
  it('the idle sweep converts nothing below the floor and every chat with room', async () => {
    for (const [storage, finished] of [
      [LOW, 0],
      [ROOM, 2]
    ] as const) {
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
      maintenance.stop()
      expect(writes.filter((kind) => kind === 'import-page')).toHaveLength(finished)
      expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(finished)
      expect(errors).toEqual(finished ? [] : [deferred])
    }
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
    [
      'a failed measure',
      () => {
        throw new Error('statfs failed')
      }
    ]
  ])('after %s, the retry measures again and resumes once space frees', async (_, first) => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let measure: () => JournalConversionStorage = first
    const { conversions, writes } = conversion(() => measure())
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    measure = () => ROOM
    // Inside the backoff nothing is attempted.
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes).toEqual([])
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
})
