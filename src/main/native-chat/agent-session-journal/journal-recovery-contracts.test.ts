import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JournalHostDatabase } from './journal-host-database'
import { createTrackedJournalOpener } from './journal-host-database-test-support'
import { registerJournalStoreTests } from './journal-store.spec'
import { registerJournalCrashBoundaryTests } from './journal-crash-boundary.spec'
import { registerJournalEpochReplacementTests } from './journal-epoch-replacement.spec'
import { registerJournalItemProvenanceTests } from './journal-item-provenance.spec'
import { registerJournalLifecycleBatchAppenderTests } from './journal-lifecycle-batch-appender.spec'
import { registerJournalUnknownContentTests } from './journal-unknown-content.spec'
import { registerJournalUnknownRowKindTests } from './journal-unknown-row-kind.spec'
import { registerJournalStopAndResumeRowsTests } from './journal-stop-and-resume-rows.spec'

afterEach(() => vi.restoreAllMocks())

describe('journal-store', registerJournalStoreTests)
describe('journal-crash-boundary', registerJournalCrashBoundaryTests)
describe('journal-epoch-replacement', registerJournalEpochReplacementTests)
describe('journal-item-provenance', registerJournalItemProvenanceTests)
describe('journal-lifecycle-batch-appender', registerJournalLifecycleBatchAppenderTests)
describe('journal-unknown-content', registerJournalUnknownContentTests)
describe('journal-unknown-row-kind', registerJournalUnknownRowKindTests)
describe('journal-stop-and-resume-rows', registerJournalStopAndResumeRowsTests)

it.each([false, true])(
  'joins the captured scoped database close and retains its profile on rejection=%s',
  async (reject) => {
    const root = await mkdtemp(join(tmpdir(), 'orca-scoped-close-'))
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let database: JournalHostDatabase | undefined
    let close: (() => Promise<void>) | undefined
    let restore = () => {}
    let restoreOwner = () => {}
    let nativeRetirement:
      | Promise<{ kind: 'returned' } | { kind: 'threw'; error: unknown }>
      | undefined
    let retirement: Promise<{ kind: 'returned' } | { kind: 'threw'; error: unknown }> | undefined
    let bodyFailed = false
    let bodyError: unknown
    const cleanupErrors: unknown[] = []
    try {
      database = JournalHostDatabase.open(root)
      const owner = database
      const closeOwner = owner.close.bind(owner)
      close = closeOwner
      const ownerClose = vi.spyOn(owner, 'close').mockImplementation(() => {
        const operation = closeOwner()
        nativeRetirement = operation.then(
          () => ({ kind: 'returned' as const }),
          (error: unknown) => ({ kind: 'threw' as const, error })
        )
        return operation
      })
      restoreOwner = () => ownerClose.mockRestore()
      const checkpoint = owner['checkpoint']!
      const closeCheckpoint = checkpoint.close.bind(checkpoint)
      const checkpointClose = vi.spyOn(checkpoint, 'close').mockImplementationOnce(async () => {
        entered.resolve()
        await held.promise
        await closeCheckpoint()
        if (reject) {
          throw undefined
        }
      })
      restore = () => checkpointClose.mockRestore()
      const journals = createTrackedJournalOpener({ scoped: true })
      journals.ownRoot(root)
      expect(journals.database(root, owner)).toBe(owner)
      let settled = false
      retirement = journals.dispose().then(
        () => {
          settled = true
          return { kind: 'returned' as const }
        },
        (error: unknown) => {
          settled = true
          return { kind: 'threw' as const, error }
        }
      )
      const first = await Promise.race([
        entered.promise.then(() => 'entered' as const),
        retirement.then(() => 'retired-before-entry' as const)
      ])
      expect(first).toBe('entered')
      expect(checkpointClose).toHaveBeenCalledOnce()
      expect(ownerClose).toHaveBeenCalledOnce()
      expect(settled).toBe(false)
      expect(owner.isClosed).toBe(false)
      expect((await stat(root)).isDirectory()).toBe(true)
      held.resolve()
      const outcome = await retirement
      if (reject) {
        expect(outcome.kind).toBe('threw')
        if (outcome.kind !== 'threw' || !(outcome.error instanceof AggregateError)) {
          throw new Error('scoped close rejection was lost')
        }
        const aggregate = outcome.error.errors[0]
        expect(aggregate).toBeInstanceOf(AggregateError)
        if (!(aggregate instanceof AggregateError) || !(aggregate.cause instanceof Map)) {
          throw new Error('failed native owner was not retained')
        }
        expect(aggregate.cause.has(owner)).toBe(true)
        expect(aggregate.errors).toHaveLength(1)
        const profile = aggregate.errors[0]
        expect(profile).toBeInstanceOf(AggregateError)
        if (!(profile instanceof AggregateError)) {
          throw new Error('native close failure was not preserved')
        }
        expect(profile.errors).toEqual([undefined])
        expect(owner.isClosed).toBe(false)
        expect((await stat(root)).isDirectory()).toBe(true)
        expect(owner.db.prepare('SELECT 1 AS alive').get()).toMatchObject({ alive: 1 })
      } else {
        expect(outcome).toEqual({ kind: 'returned' })
        expect(owner.isClosed).toBe(true)
        await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } catch (error) {
      bodyFailed = true
      bodyError = error
    } finally {
      held.resolve()
      try {
        const outcome = await retirement
        if (bodyFailed && outcome?.kind === 'threw') {
          cleanupErrors.push(outcome.error)
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      try {
        const outcome = await nativeRetirement
        if (bodyFailed && outcome?.kind === 'threw') {
          cleanupErrors.push(outcome.error)
        }
      } catch (error) {
        cleanupErrors.push(error)
      }
      for (const restoreSpy of [restore, restoreOwner]) {
        try {
          restoreSpy()
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      try {
        await close?.()
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (!database || database.isClosed) {
        try {
          await rm(root, { recursive: true, force: true })
        } catch (error) {
          cleanupErrors.push(error)
        }
      } else {
        cleanupErrors.push(new Error('retained native owner prevents fixture directory removal'))
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        bodyFailed ? [bodyError, ...cleanupErrors] : cleanupErrors,
        'scoped close witness cleanup failed'
      )
    }
    if (bodyFailed) {
      throw bodyError
    }
  }
)
