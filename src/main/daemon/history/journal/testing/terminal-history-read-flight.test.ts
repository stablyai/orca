import { afterEach, describe, expect, it, vi } from 'vitest'
import { openReads, readDeep, removeReadFixtureRoots } from './terminal-history-read-fixture'

afterEach(() => {
  vi.restoreAllMocks()
  removeReadFixtureRoots()
})

describe('shared deep-history flight', () => {
  it.each([
    ['cacheable', undefined],
    ['uncached', 1024]
  ] as const)(
    'serves queued and arriving %s readers of one cut from one reconstruction',
    async (_, budget) => {
      const { reads, openJournal, record } = openReads(budget)
      const journal = openJournal('flight-shared')
      record(journal, 'SHARED_ROW_ONE\r\nSHARED_ROW_TWO\r\n')
      const reconstructions = vi.spyOn(journal, 'readImage')

      const answers = await Promise.all([readDeep(reads, journal), readDeep(reads, journal)])

      expect(answers[0]).toContain('SHARED_ROW_TWO')
      expect(answers[1]).toBe(answers[0])
      expect(reconstructions).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps a joined reader when the leader leaves, and cancels work nobody wants', async () => {
    const { reads, openJournal, record } = openReads()
    const journal = openJournal('flight-cancel')
    record(journal, 'JOINED_ROW\r\n')
    // Hold the reconstruction open so the published flight can be joined and left.
    let gate = Promise.withResolvers<void>()
    const readImage = journal.readImage.bind(journal)
    const reconstructions = vi.spyOn(journal, 'readImage').mockImplementation(async (...args) => {
      await gate.promise
      return readImage(...args)
    })
    const leaderAbort = new AbortController()
    const leader = readDeep(reads, journal, leaderAbort.signal)
    await vi.waitFor(() => expect(reconstructions).toHaveBeenCalledTimes(1))
    const joiner = readDeep(reads, journal)
    leaderAbort.abort()
    gate.resolve()

    expect(await leader).toBeNull()
    expect(await joiner).toContain('JOINED_ROW')
    expect(reconstructions).toHaveBeenCalledTimes(1)

    // Once every reader has left, nobody's work continues.
    const lone = new AbortController()
    gate = Promise.withResolvers<void>()
    record(journal, 'UNWANTED_ROW\r\n')
    const unwanted = readDeep(reads, journal, lone.signal)
    await vi.waitFor(() => expect(reconstructions).toHaveBeenCalledTimes(2))
    lone.abort()
    gate.resolve()
    expect(await unwanted).toBeNull()
    expect(await readDeep(reads, journal)).toContain('UNWANTED_ROW')
    // The abandoned flight installed nothing: the later reader had to reconstruct.
    expect(reconstructions).toHaveBeenCalledTimes(3)
  })

  // Coalesced output changes content without new intake; the old answer must not be reused.
  it('never reuses an answer after output coalesces into the queued tail', async () => {
    const { reads, openJournal, record } = openReads()
    const journal = openJournal('flight-coalesce')
    record(journal, 'BEFORE_')
    expect(await readDeep(reads, journal)).toContain('BEFORE_')
    record(journal, 'AFTER\r\n')

    expect(await readDeep(reads, journal)).toContain('BEFORE_AFTER')
  })

  it('evicts a quiet journal for another, but keeps a leased answer charged until release', async () => {
    // Room for one of these answers but not two.
    const { reads, openJournal, record, rows } = openReads(150_000)
    const first = openJournal('flight-quiet')
    const second = openJournal('flight-busy')
    record(first, rows('QUIET_ROW', 600))
    record(second, rows('BUSY_ROW', 600))
    const firstRead = vi.spyOn(first, 'readImage')
    expect(await readDeep(reads, first)).toContain('QUIET_ROW')
    const held = reads.admit(new AbortController().signal)!
    expect(await held.acquire(first, 5000, async () => {})).toBe('image')
    // The leased answer fills the budget: the other journal is still served, uncached.
    const secondRead = vi.spyOn(second, 'readImage')
    expect(await readDeep(reads, second)).toContain('BUSY_ROW')
    expect(await readDeep(reads, second)).toContain('BUSY_ROW')
    expect(secondRead).toHaveBeenCalledTimes(2)
    held.release()
    expect(await readDeep(reads, second)).toContain('BUSY_ROW')
    expect(await readDeep(reads, second)).toContain('BUSY_ROW')
    expect(secondRead).toHaveBeenCalledTimes(3)
    // The quiet journal's answer was evicted, not kept uncharged.
    expect(await readDeep(reads, first)).toContain('QUIET_ROW')
    expect(firstRead).toHaveBeenCalledTimes(2)
  })

  // Writer pressure severs the frozen source and frees its charge without gapping the writer.
  it('releases a severed source at once and answers correctly afterwards', async () => {
    const { reads, openJournal, record, prime } = openReads()
    const journal = openJournal('flight-pressure')
    await prime(journal)
    record(journal, 'PRESSURED_ROW\r\n')
    const consumer = reads.admit(new AbortController().signal)!
    const found = await consumer.acquire(journal, 5000, async () => {})
    // This proof needs the actual cold flight; a cached image or a refusal cannot stand in for it.
    if (found === 'image' || found === null) {
      throw new Error(`expected a cold flight, got ${String(found)}`)
    }
    expect(found.capture()).toBe(true)
    // Still shared with the writer's queue, so the read adds nothing until pressure severs it.
    expect(reads.readSourceBytes).toBe(0)
    reads.relievePressure()
    expect(reads.readSourceBytes).toBe(0)
    expect(await consumer.awaitFlight(found)).toBe(false)
    consumer.release()

    expect(journal.gapped).toBe(false)
    expect(await readDeep(reads, journal)).toContain('PRESSURED_ROW')
  })

  // F1: a title sliced from a large pending burst must survive exactly, lone surrogate included.
  it('keeps every code unit of a long title read from a large pending burst', async () => {
    const { reads, openJournal, record, prime } = openReads()
    const journal = openJournal('flight-title')
    await prime(journal)
    const title = 'Agent working on a long task \ud800 done'
    record(journal, `${'x'.repeat(60_000)}\x1b]2;${title}\x07TITLE_ROW\r\n`)
    const consumer = reads.admit(new AbortController().signal)!
    const found = await consumer.acquire(journal, 5000, async () => {})
    if (found !== 'image' && found !== null) {
      found.capture()
      await consumer.awaitFlight(found)
    }

    expect(consumer.image?.snapshot.lastTitle).toBe(title)
    consumer.release()
  })
})
