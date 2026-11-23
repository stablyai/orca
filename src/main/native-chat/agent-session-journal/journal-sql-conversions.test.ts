import { describe, expect, it } from 'vitest'
import { JournalConversionStorageError, JournalSqlConversions } from './journal-sql-conversions'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'

const GB = 1024 ** 3

function conversion(storage: { freeBytes: number; totalBytes: number; remainingBytes?: number }[]) {
  let index = 0
  let page = false
  const writes: string[] = []
  const conversions = new JournalSqlConversions(
    {
      maintain: async (operation) => {
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
    },
    {
      database: async () => ({ kind: 'sessions', sessionIds: [] }),
      compareLegacyChat: async () => null,
      importState: async () => ({ state: 'converting' as const, epoch: null }),
      prepareConversion: async () => ({
        header: {
          sessionId: 'chat',
          workspaceId: 'workspace',
          epoch: 'epoch',
          head: {
            lastSequence: 0,
            highestFence: 0,
            contextBoundary: 0,
            lastActivityAt: 0,
            derivedTurnItemId: null,
            historyOrigin: null,
            queuePauseMarks: { latestStop: null, resumedSequence: 0, reopenedSequence: 0 },
            queueFailureBoundary: 0
          }
        },
        next: async () => {
          if (page) {
            return null
          }
          page = true
          return { kind: 'items' as const, rows: [] }
        },
        close: async () => {}
      }),
      conversionStorage: async () => storage[Math.min(index++, storage.length - 1)]!
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this focused fixture only reaches conversion calls.
    } as unknown as Pick<
      JournalSqlReaderPool,
      'database' | 'compareLegacyChat' | 'importState' | 'prepareConversion' | 'conversionStorage'
    >,
    async () => {}
  )
  return { conversions, writes }
}

describe('JournalSqlConversions storage guard', () => {
  it('defers a background conversion when the pending source estimate would cross the disk floor', async () => {
    const { conversions, writes } = conversion([
      { freeBytes: 6 * GB, totalBytes: 100 * GB, remainingBytes: GB }
    ])
    await expect(conversions.ensure('chat', false)).rejects.toBeInstanceOf(
      JournalConversionStorageError
    )
    expect(writes).toEqual([])
  })

  it('continues a foreground conversion despite low disk space', async () => {
    const { conversions, writes } = conversion([{ freeBytes: GB, totalBytes: 100 * GB }])
    await expect(conversions.ensure('chat')).resolves.toBe('epoch')
    expect(writes).toContain('import-finish')
  })

  it('stops between conversion pages when the disk reaches the floor', async () => {
    const { conversions, writes } = conversion([
      { freeBytes: 20 * GB, totalBytes: 100 * GB, remainingBytes: 0 },
      { freeBytes: GB, totalBytes: 100 * GB }
    ])
    await expect(conversions.ensure('chat', false)).rejects.toBeInstanceOf(
      JournalConversionStorageError
    )
    expect(writes).toContain('import-discard')
    expect(writes).not.toContain('import-page')
  })
})
