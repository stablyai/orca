import { afterEach, describe, expect, it, vi } from 'vitest'
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

const frameCharge = (data: string): number => Buffer.byteLength(data, 'utf8') + 5

// N2: frozen records still shared with the writer's queue are one copy, not two.
describe('frozen read backing', () => {
  // Queues about 8 MiB of real records and replays them through the parser.
  it('admits a read of 127 full records just under the session bound', async () => {
    const { reads, openJournal, record, prime } = openReads()
    const journal = openJournal('backing-near-cap')
    await prime(journal)
    const appends = gateAppends()
    // Exactly 64 Ki code units each, so none coalesces: 127 × 65,541 = 8,323,707 bytes queued.
    for (let index = 0; index < 127; index += 1) {
      const marker = `NEAR_${String(index).padStart(3, '0')}_`
      record(journal, `${marker}${'z'.repeat(65_536 - marker.length)}`)
    }
    const reconstruction = gateReconstruction(journal)
    const read = readDeep(reads, journal)
    await vi.waitFor(() => expect(reconstruction.calls).toHaveBeenCalledTimes(1))
    expect(reads.readSourceBytes).toBe(0)
    reconstruction.open()

    const text = await read
    expect(text).toContain('NEAR_126_')
    expect(text).toContain('NEAR_122_')
    expect(journal.gapped).toBe(false)
    appends.open()
    await journal.flush()
  }, 60_000)

  // Queues and replays 10,000 real records through the parser.
  it('admits a read of exactly 10,000 queued records', async () => {
    const { reads, openJournal, record, prime } = openReads()
    const journal = openJournal('backing-record-cap')
    await prime(journal)
    const appends = gateAppends()
    record(journal, 'RECORD_CAP_ROW\r\n')
    for (let index = 1; index < 10_000; index += 1) {
      journal.record({ kind: 'resize', cols: 80, rows: 24 })
    }
    const reconstruction = gateReconstruction(journal)
    const read = readDeep(reads, journal)
    await vi.waitFor(() => expect(reconstruction.calls).toHaveBeenCalledTimes(1))
    expect(reads.readSourceBytes).toBe(0)
    reconstruction.open()

    expect(await read).toContain('RECORD_CAP_ROW')
    expect(journal.gapped).toBe(false)
    appends.open()
    await journal.flush()
  }, 60_000)

  // A captured tail becomes the reader's only when a write actually replaces it, and only once.
  it('charges a replaced captured tail once, keeps the cut, and keeps it through commit', async () => {
    const { reads, openJournal, record, prime } = openReads()
    const journal = openJournal('backing-tail')
    await prime(journal)
    const appends = gateAppends()
    record(journal, 'HEAD_ROW\r\n')
    journal.record({ kind: 'resize', cols: 80, rows: 24 })
    record(journal, 'TAIL_A_ROW\r\n')
    const reconstruction = gateReconstruction(journal)
    const atCut = readDeep(reads, journal)
    await vi.waitFor(() => expect(reconstruction.calls).toHaveBeenCalledTimes(1))
    expect(reads.readSourceBytes).toBe(0)

    record(journal, 'TAIL_B_ROW\r\n')
    expect(reads.readSourceBytes).toBe(frameCharge('TAIL_A_ROW\r\n'))
    record(journal, 'TAIL_C_ROW\r\n')
    expect(reads.readSourceBytes).toBe(frameCharge('TAIL_A_ROW\r\n'))

    // Retiring every captured record leaves the whole prefix the reader's, the tail counted once.
    appends.open()
    await journal.flush()
    expect(reads.readSourceBytes).toBe(
      frameCharge('HEAD_ROW\r\n') + 9 + frameCharge('TAIL_A_ROW\r\n')
    )
    reconstruction.open()
    const cut = await atCut
    expect(cut).toContain('TAIL_A_ROW')
    expect(cut).not.toContain('TAIL_B_ROW')
    expect(reads.readSourceBytes).toBe(0)

    const later = (await readDeep(reads, journal)) ?? ''
    expect(later.split('TAIL_B_ROW')).toHaveLength(2)
    expect(later.split('TAIL_C_ROW')).toHaveLength(2)
  })

  // Fills the record bound with real writes, then replays the survivor from files.
  it('revokes an already-replaced tail before later writes exhaust the reader and writer together', async () => {
    const { reads, openJournal, record, prime } = openReads()
    const journal = openJournal('backing-replaced-tail-pressure')
    await prime(journal)
    const appends = gateAppends()
    record(journal, 'HEAD_ROW\r\n')
    for (let index = 0; index < 9_996; index += 1) {
      journal.record({ kind: 'resize', cols: 80, rows: 24 })
    }
    record(journal, 'TAIL_A_ROW\r\n')
    const reconstruction = gateReconstruction(journal)
    const atCut = readDeep(reads, journal)
    await vi.waitFor(() => expect(reconstruction.calls).toHaveBeenCalledTimes(1))
    expect(reads.readSourceBytes).toBe(0)

    record(journal, 'TAIL_B_ROW\r\n')
    expect(reads.readSourceBytes).toBe(frameCharge('TAIL_A_ROW\r\n'))
    journal.record({ kind: 'resize', cols: 81, rows: 24 })
    expect(reads.readSourceBytes).toBe(frameCharge('TAIL_A_ROW\r\n'))
    journal.record({ kind: 'resize', cols: 82, rows: 25 })
    expect(journal.gapped).toBe(false)
    expect(reads.readSourceBytes).toBe(0)
    reconstruction.open()
    expect(await atCut).toBeNull()
    appends.open()
    await journal.flush()

    record(journal, 'AFTER_PRESSURE_ROW\r\n')
    await journal.flush()
    const consumer = reads.admit(new AbortController().signal)!
    try {
      const found = await consumer.acquire(journal, 5000, async () => {})
      expect(found).not.toBeNull()
      if (found && found !== 'image') {
        expect(found.capture()).toBe(true)
        expect(await consumer.awaitFlight(found)).toBe(true)
      }
      const snapshot = consumer.image!.snapshot
      expect(snapshot.cols).toBe(82)
      expect(snapshot.rows).toBe(25)
      const later = snapshot.scrollbackAnsi + snapshot.snapshotAnsi
      expect(later.split('TAIL_A_ROW')).toHaveLength(2)
      expect(later.split('TAIL_B_ROW')).toHaveLength(2)
      expect(later.split('AFTER_PRESSURE_ROW')).toHaveLength(2)
    } finally {
      consumer.release()
    }
    expect(journal.gapped).toBe(false)
  }, 60_000)
})
