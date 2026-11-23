import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  JournalConversionStorageError,
  JournalSqlConversions,
  type JournalBackgroundConversions
} from './journal-sql-conversions'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import { JournalSavedChatConversion } from './journal-saved-chat-conversion'
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
  const deleted = new Set<string>()
  const readers: Pick<
    JournalSqlReaderPool,
    'database' | 'compareLegacyChat' | 'importState' | 'prepareConversion' | 'conversionStorage'
  > = {
    database: async (read) => {
      if (read.kind === 'chat-exists') {
        return { kind: 'chat-exists', exists: !deleted.has(read.sessionId) }
      }
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
  return { conversions, writes, readers, writer, listedAfter, deleted }
}

const deferred = expect.any(JournalConversionStorageError)

describe('JournalSqlConversions storage guard', () => {
  it('below the floor ends the whole pass and backs off, then resumes after the last chat it finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let low = true
    const { conversions, writes, readers, writer, listedAfter } = conversion(
      (sessionId) =>
        sessionId === 'b' && low ? { freeBytes: 4 * GB, totalBytes: 100 * GB } : ROOM,
      1,
      ['a', 'b', 'c']
    )
    const compare = vi.spyOn(conversions, 'compareLegacyChats')
    const errors: unknown[] = []
    const maintenance = new JournalSqlBackgroundMaintenance(
      writer,
      readers,
      conversions,
      new JournalSqlActivity(),
      (error) => errors.push(error)
    )
    await maintenance.start()
    // The disk is at the floor at 'b': the pass ends there, and 'c' waits for the backoff too.
    expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(1)
    expect(conversions.deferred()).toBe(true)
    expect(errors).toEqual([deferred])
    low = false
    listedAfter.length = 0
    // The periodic tick after the backoff resumes after 'a', without comparing chats again.
    await vi.advanceTimersByTimeAsync(60_000)
    await maintenance.settled()
    maintenance.stop()
    vi.useRealTimers()
    expect(listedAfter[0]).toBe('a')
    expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(3)
    expect(compare).toHaveBeenCalledTimes(1)
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

  it('a chat that stopped partway starts again only with room for more than that attempt used', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let free = 40 * GB
    let checks = 0
    // A 10 GB chat starts with 40 GB free; its second batch finds 9 GB, after using 31 GB.
    const { conversions, writes } = conversion((sessionId, sizedAt) => {
      if (sessionId !== undefined) {
        return sizedAt === 'v1'
          ? { freeBytes: free, totalBytes: 1000 * GB, sizedAt }
          : { freeBytes: free, totalBytes: 1000 * GB, remainingBytes: 10 * GB, sizedAt: 'v1' }
      }
      return ++checks === 2
        ? { freeBytes: 9 * GB, totalBytes: 1000 * GB }
        : { freeBytes: free, totalBytes: 1000 * GB }
    }, 3)
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    now += 60_000
    writes.length = 0
    // Once the partial copy is gone, the same 40 GB can't hold 1.5x the 31 GB used above the floor.
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes).not.toContain('import-page')
    now += 120_000
    free = 57 * GB
    await expect(conversions.ensure('chat', false)).resolves.toBe('epoch')
  })

  it('a skipped chat does not hold later chats, logs one line per pass, and converts on the backoff pass', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let low = true
    const asked: (string | undefined)[] = []
    const { conversions, writes, readers, writer } = conversion(
      (sessionId, sizedAt) => {
        if (sessionId === 'b') {
          asked.push(sizedAt)
          return low ? LOW : ROOM
        }
        return ROOM
      },
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
    expect(errors).toEqual([new Error('journal conversion skipped 1 chats for storage')])
    expect(conversions.deferred()).toBe(true)
    low = false
    await vi.advanceTimersByTimeAsync(60_000)
    await maintenance.settled()
    maintenance.stop()
    vi.useRealTimers()
    expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(3)
    // The skip dropped its size, so the retry measured it again.
    expect(asked).toEqual([undefined, undefined])
    expect(errors).toHaveLength(1)
  })

  it('a chat that stops again needs twice its last requirement, so repeats grow', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let free = 26 * GB
    let checks = 0
    // A 10 GB chat starts with 26 GB free (room for 1.5x above the 10 GB floor) and stops at 9 GB,
    // having used 17 GB: less than twice its 10 GB estimate, so the next try needs 1.5x 20 GB.
    const { conversions, writes } = conversion((sessionId, sizedAt) => {
      if (sessionId !== undefined) {
        return sizedAt === 'v1'
          ? { freeBytes: free, totalBytes: 1000 * GB, sizedAt }
          : { freeBytes: free, totalBytes: 1000 * GB, remainingBytes: 10 * GB, sizedAt: 'v1' }
      }
      return ++checks === 2
        ? { freeBytes: 9 * GB, totalBytes: 1000 * GB }
        : { freeBytes: free, totalBytes: 1000 * GB }
    }, 3)
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    now += 60_000
    writes.length = 0
    free = 39 * GB
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes).not.toContain('import-page')
    free = 40 * GB
    await expect(conversions.ensure('chat', false)).resolves.toBe('epoch')
  })

  it('a chat deleted during the backoff is never re-imported', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    let low = true
    const { conversions, writes, readers, writer, deleted } = conversion(
      (sessionId) => (sessionId === 'b' && low ? LOW : ROOM),
      1,
      ['a', 'b']
    )
    const maintenance = new JournalSqlBackgroundMaintenance(
      writer,
      readers,
      conversions,
      new JournalSqlActivity(),
      () => {}
    )
    await maintenance.start()
    expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(1)
    // 'b' was skipped; the user deletes it, then space frees and the backoff pass retries.
    deleted.add('b')
    low = false
    await vi.advanceTimersByTimeAsync(60_000)
    await maintenance.settled()
    maintenance.stop()
    vi.useRealTimers()
    expect(writes.filter((kind) => kind === 'import-page')).toHaveLength(1)
    expect(writes.filter((kind) => kind === 'import-finish')).toHaveLength(1)
  })

  it('a pass keeps every skipped chat however many there are', async () => {
    const ids = Array.from({ length: 130_000 }, (_, index) => `c${index}`)
    const skip = new JournalConversionStorageError(true, 1)
    const deferPass = vi.fn()
    const readers: Pick<JournalSqlReaderPool, 'database'> = {
      database: async (read) => ({
        kind: 'sessions',
        sessionIds: read.kind === 'sessions' && read.after === null ? ids : []
      })
    }
    const conversions: JournalBackgroundConversions = {
      ensure: async () => null,
      compareLegacyChats: async () => {},
      deferred: () => false,
      resumed: () => false,
      passCompleted: () => {},
      deferPass
    }
    const pass = new JournalSavedChatConversion(
      readers,
      conversions,
      async () => true,
      async () => {
        tried++
        throw skip
      },
      () => {}
    )
    let tried = 0
    await pass.run()
    expect(tried).toBe(130_000)
    // An unchanged retry tries the first chat only, without sorting or copying the rest.
    const sort = vi.spyOn(Array.prototype, 'sort')
    await expect(pass.run()).resolves.toBeUndefined()
    expect(tried).toBe(130_001)
    expect(sort).not.toHaveBeenCalled()
    expect(deferPass).toHaveBeenCalledTimes(2)
    await pass.run()
    expect(tried).toBe(130_002)
    expect(deferPass).toHaveBeenCalledTimes(3)
  })

  it('the last two skipped chats keep their size, so unchanged retries do not size them again', async () => {
    const asked: [string | undefined, string | undefined][] = []
    const { conversions } = conversion((sessionId, sizedAt) => {
      if (sessionId === undefined) {
        return ROOM
      }
      asked.push([sessionId, sizedAt])
      return sizedAt === 'v1'
        ? { freeBytes: LOW.freeBytes, totalBytes: LOW.totalBytes, sizedAt }
        : { ...LOW, sizedAt: 'v1' }
    })
    // The pass and the cleanup proof each retry their own skipped chat.
    for (const sessionId of ['a', 'b', 'a', 'b']) {
      await expect(conversions.ensure(sessionId, false)).rejects.toEqual(deferred)
    }
    // A third skipped chat takes the oldest kept size.
    for (const sessionId of ['c', 'a']) {
      await expect(conversions.ensure(sessionId, false)).rejects.toEqual(deferred)
    }
    expect(asked).toEqual([
      ['a', undefined],
      ['b', undefined],
      ['a', 'v1'],
      ['b', 'v1'],
      ['c', undefined],
      ['a', undefined]
    ])
  })

  it('a skipped chat admitted on its kept size still records a stop', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let free = 20 * GB
    let checks = 0
    // A 10 GB chat is skipped at 20 GB free, then admitted at 26 GB on its kept size, and stops
    // at 9 GB: the next try needs twice its 10 GB above the floor, not the same 26 GB again.
    const { conversions, writes } = conversion((sessionId, sizedAt) => {
      if (sessionId !== undefined) {
        return sizedAt === 'v1'
          ? { freeBytes: free, totalBytes: 1000 * GB, sizedAt }
          : { freeBytes: free, totalBytes: 1000 * GB, remainingBytes: 10 * GB, sizedAt: 'v1' }
      }
      return ++checks === 2
        ? { freeBytes: 9 * GB, totalBytes: 1000 * GB }
        : { freeBytes: free, totalBytes: 1000 * GB }
    }, 3)
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    free = 26 * GB
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes).toContain('import-page')
    now += 60_000
    writes.length = 0
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes).not.toContain('import-page')
  })

  it('a stopped chat never needs more than the room its attempt started with', async () => {
    let now = 1_000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    let free = 100 * GB
    let checks = 0
    // A 60 GB chat starts with 100 GB free and stops at 9 GB; twice 60 GB is more than it had,
    // so its requirement is 100 GB, and 1.5x that above the 10 GB floor is 160 GB.
    const { conversions, writes } = conversion((sessionId, sizedAt) => {
      if (sessionId !== undefined) {
        return sizedAt === 'v1'
          ? { freeBytes: free, totalBytes: 1000 * GB, sizedAt }
          : { freeBytes: free, totalBytes: 1000 * GB, remainingBytes: 60 * GB, sizedAt: 'v1' }
      }
      return ++checks === 2
        ? { freeBytes: 9 * GB, totalBytes: 1000 * GB }
        : { freeBytes: free, totalBytes: 1000 * GB }
    }, 3)
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    now += 60_000
    writes.length = 0
    free = 159 * GB
    await expect(conversions.ensure('chat', false)).rejects.toEqual(deferred)
    expect(writes).not.toContain('import-page')
    free = 160 * GB
    await expect(conversions.ensure('chat', false)).resolves.toBe('epoch')
  })
})
