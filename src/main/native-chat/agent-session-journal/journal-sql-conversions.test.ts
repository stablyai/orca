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
  storage: (
    sessionId?: string,
    sizedAt?: string
  ) => JournalConversionStorage | null | Promise<JournalConversionStorage | null>,
  pages = 1,
  sessionIds = ['chat']
) {
  const writes: string[] = []
  const listedAfter: (string | null)[] = []
  const readers: Pick<
    JournalSqlReaderPool,
    'database' | 'compareLegacyChat' | 'importState' | 'prepareConversion' | 'conversionStorage'
  > = {
    database: async (read) => {
      if (read.kind === 'retired-heads') {
        return { kind: 'retired-heads', heads: [], through: null }
      }
      if (read.kind !== 'sessions') {
        return { kind: 'forgotten-chats', sessionIds: [] }
      }
      listedAfter.push(read.after)
      const after = read.after
      return { kind: 'sessions', sessionIds: sessionIds.filter((id) => !after || id > after) }
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
    conversionStorage: async (sessionId, sizedAt) => storage(sessionId, sizedAt)
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
  return { conversions, writes, readers, writer, listedAfter }
}

const deferred = expect.any(JournalConversionStorageError)

describe('JournalSqlConversions storage guard', () => {
  it('the idle sweep skips a chat too big for the room left, converts the rest, and retries it alone once space frees', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let low = true
    const { conversions, writes, readers, writer, listedAfter } = conversion(
      (sessionId) => (sessionId === 'b' && low ? LOW : ROOM),
      1,
      ['a', 'b', 'c']
    )
    const errors: unknown[] = []
    const maintenance = new JournalSqlBackgroundMaintenance(
      writer,
      readers,
      conversions,
      new JournalSqlActivity(),
      (error) => errors.push(error)
    )
    await maintenance.start()
    expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(2)
    expect(conversions.waiting()).toEqual(['b'])
    expect(errors).toEqual([deferred])
    low = false
    listedAfter.length = 0
    // The periodic tick after the backoff retries it without walking the chats again.
    await vi.advanceTimersByTimeAsync(60_000)
    await maintenance.settled()
    maintenance.stop()
    vi.useRealTimers()
    expect(listedAfter).toEqual([])
    expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(3)
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
    ['a full disk', () => ({ freeBytes: 4 * GB, totalBytes: 100 * GB })],
    ['a failed measure', () => null]
  ])('after %s, the retry measures again and resumes once space frees', async (_, first) => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let measure: () => JournalConversionStorage | null = first
    const { conversions, writes } = conversion(() => measure())
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    measure = () => ROOM
    // Inside the backoff nothing converts.
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes).not.toContain('import-page')
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

  it('a chat that stopped partway waits for the room it started with, without holding back others', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let free = 60 * GB
    let checks = 0
    // Its third space check (the second batch) finds 4 GB left.
    const { conversions, writes } = conversion(
      () =>
        ++checks === 3 ? { freeBytes: 4 * GB, totalBytes: 100 * GB } : { ...ROOM, freeBytes: free },
      3
    )
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    now += 60_000
    writes.length = 0
    // Less room than it started with would stop again sooner.
    free = 59 * GB
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes).not.toContain('import-page')
    expect(conversions.deferred()).toBe(false)
    free = 60 * GB
    await expect(conversions.ensure('chat', false)).resolves.toBe('epoch')
  })

  it('a retry reuses a deferred chat size while the original is unchanged, and measures it again once it changes', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let version = 'v1'
    const asked: (string | undefined)[] = []
    const { conversions } = conversion((sessionId, sizedAt) => {
      if (sessionId === undefined) {
        return ROOM
      }
      asked.push(sizedAt)
      // 20 GB free cannot hold 1.5x this 20 GB chat above the floor.
      return sizedAt === version
        ? { freeBytes: 20 * GB, totalBytes: 100 * GB, sizedAt }
        : { ...LOW, sizedAt: version }
    })
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    now += 60_000
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(asked).toEqual([undefined, 'v1'])
    version = 'v2'
    now += 120_000
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(asked).toEqual([undefined, 'v1', 'v1'])
  })

  it('a resume retries a chat waiting for room once it may be there, without comparing chats again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let free = 60 * GB
    let checks = 0
    const { conversions, writes, readers, writer } = conversion(
      (sessionId) =>
        sessionId === undefined && ++checks === 2
          ? { freeBytes: 4 * GB, totalBytes: 100 * GB }
          : { ...ROOM, freeBytes: free },
      2,
      ['a', 'b']
    )
    const compare = vi.spyOn(conversions, 'compareLegacyChats')
    const maintenance = new JournalSqlBackgroundMaintenance(
      writer,
      readers,
      conversions,
      new JournalSqlActivity(),
      () => {}
    )
    // 'a' stops at its second batch; the backoff ends before 'b', which then converts.
    await maintenance.start()
    free = 59 * GB
    await vi.advanceTimersByTimeAsync(60_000)
    await maintenance.settled()
    expect(conversions.waiting()).toEqual(['a'])
    free = 200 * GB
    await vi.advanceTimersByTimeAsync(120_000)
    await maintenance.settled()
    maintenance.stop()
    vi.useRealTimers()
    expect(conversions.waiting()).toEqual([])
    expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(2)
    expect(compare).toHaveBeenCalledTimes(1)
  })
})
