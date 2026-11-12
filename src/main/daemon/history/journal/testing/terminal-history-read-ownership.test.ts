import { afterEach, describe, expect, it, vi } from 'vitest'
import { RevocablePendingSource } from '../terminal-history-pending-source'
import {
  gateAppends,
  gateReconstruction,
  openReads,
  readDeep,
  removeReadFixtureRoots
} from './terminal-history-read-fixture'

afterEach(() => {
  vi.restoreAllMocks()
  removeReadFixtureRoots()
})

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const chunk = (marker: string): string => `${marker}${'y'.repeat(64 * 1024 - 64)}\r\n`

describe('deep-history read ownership', () => {
  // CR2: a deadline that passed while the ownership barrier settled used to be missed.
  it('withdraws a reader whose deadline passes during its barrier, with a cached answer', async () => {
    const { reads, openJournal, record } = openReads()
    const journal = openJournal('own-barrier-hit')
    record(journal, 'CACHED_ROW\r\n')
    expect(await readDeep(reads, journal)).toContain('CACHED_ROW')
    const barrier = Promise.withResolvers<void>()
    const deadline = new AbortController()

    const late = readDeep(reads, journal, deadline.signal, () => barrier.promise)
    deadline.abort()
    barrier.resolve()

    expect(await late).toBeNull()
    expect(await readDeep(reads, journal)).toContain('CACHED_ROW')
  })

  it('never joins a flight after its deadline passed during the barrier', async () => {
    const { reads, openJournal, record } = openReads()
    const journal = openJournal('own-barrier-join')
    record(journal, 'FLIGHT_ROW\r\n')
    const reconstruction = gateReconstruction(journal)
    const leader = readDeep(reads, journal)
    await vi.waitFor(() => expect(reconstruction.calls).toHaveBeenCalledTimes(1))
    const barrier = Promise.withResolvers<void>()
    const disconnect = new AbortController()
    const late = readDeep(reads, journal, disconnect.signal, () => barrier.promise)
    disconnect.abort()
    barrier.resolve()

    expect(await late).toBeNull()
    reconstruction.open()
    expect(await leader).toContain('FLIGHT_ROW')
    expect(reconstruction.calls).toHaveBeenCalledTimes(1)
  })

  // N2 + CR3: shared strings count once at capture; later writer growth sees the frozen backing.
  it('admits a large frozen read once, then severs it before live plus frozen exceed 8 MiB', async () => {
    const { reads, openJournal, record, prime } = openReads()
    const journal = openJournal('own-frozen')
    await prime(journal)
    const appends = gateAppends()
    for (let index = 0; index < 70; index += 1) {
      record(journal, chunk(`OLD_${index}_`))
    }
    const reconstruction = gateReconstruction(journal)
    const severed = readDeep(reads, journal)
    // About 4.4 MiB is queued and frozen at once: one copy of shared strings, so it is admitted.
    await vi.waitFor(() => expect(reconstruction.calls).toHaveBeenCalledTimes(1))
    // Unchanged queued strings are the writer's; capturing them adds no reader charge.
    expect(reads.readSourceBytes).toBe(0)

    // The writer commits that prefix out of its queue; the read alone now holds it.
    appends.open()
    await journal.flush()
    expect(reads.readSourceBytes).toBeGreaterThan(4 * 1024 * 1024)
    appends.close()
    for (let index = 0; index < 59; index += 1) {
      record(journal, chunk(`NEW_${index}_`))
    }
    // The writer alone is under its bound; the frozen read was released, not the writer gapped.
    expect(reads.readSourceBytes).toBe(0)
    reconstruction.open()
    expect(await severed).toBeNull()
    expect(journal.gapped).toBe(false)

    appends.open()
    await journal.flush()
    expect(await readDeep(reads, journal)).toContain('NEW_58_')
  }, 60_000)

  it('severs a source at a replay yield and frees its charge before the parser resumes', async () => {
    const { reads, openJournal, record, prime } = openReads()
    const journal = openJournal('own-yield')
    await prime(journal)
    const appends = gateAppends()
    for (let index = 0; index < 4; index += 1) {
      record(journal, chunk(`YIELD_${index}_`))
    }
    let chargedAtYield = -1
    const holdParser = RevocablePendingSource.prototype.holdParser
    vi.spyOn(RevocablePendingSource.prototype, 'holdParser').mockImplementation(function (
      this: RevocablePendingSource,
      dispose
    ) {
      holdParser.call(this, dispose)
      if (dispose) {
        // Runs once the replay's first slice has written and it yields.
        queueMicrotask(() => {
          reads.relievePressure()
          chargedAtYield = reads.readSourceBytes
        })
      }
    })

    expect(await readDeep(reads, journal)).toBeNull()
    expect(chargedAtYield).toBe(0)
    expect(journal.gapped).toBe(false)
    vi.mocked(RevocablePendingSource.prototype.holdParser).mockRestore()
    appends.open()
    await journal.flush()
    expect(await readDeep(reads, journal)).toContain('YIELD_3_')
  }, 60_000)

  it('lets the replay slot serve a fold while an uncached reply is still unsettled', async () => {
    const { reads, replay, openJournal, record } = openReads(1024)
    const journal = openJournal('own-slow-reply')
    record(journal, 'SLOW_REPLY_ROW\r\n')
    const reconstructions = vi.spyOn(journal, 'readImage')
    const slow = reads.admit(new AbortController().signal)!
    const found = await slow.acquire(journal, 5000, async () => {})
    expect(found !== null && found !== 'image' && found.capture()).toBe(true)
    if (found !== null && found !== 'image') {
      expect(await slow.awaitFlight(found)).toBe(true)
    }

    // The unsettled reply holds only its result; a fold takes the replay slot at once.
    const releaseFold = await replay.acquire(0)
    releaseFold()
    record(journal, 'CHANGED_ROW\r\n')
    const next = readDeep(reads, journal)
    for (let turn = 0; turn < 5; turn += 1) {
      await nextTurn()
    }
    // No second unknown result materializes beside the one still being written.
    expect(reconstructions).toHaveBeenCalledTimes(1)
    slow.release()
    expect(await next).toContain('CHANGED_ROW')
    expect(reconstructions).toHaveBeenCalledTimes(2)
  })
})
