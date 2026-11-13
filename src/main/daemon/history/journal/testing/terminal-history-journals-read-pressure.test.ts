import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalHistoryJournals } from '../terminal-history-journals'
import type { TerminalSessionJournal } from '../terminal-session-journal'
import type { TerminalHistoryReads } from '../terminal-history-read-admission'
import type * as FileReaderModule from '../../storage/terminal-history-file-reader'
import { gateAppends, gateReconstruction } from './terminal-history-read-fixture'

const sourceRead = vi.hoisted(() => ({ during: async (): Promise<void> => {} }))
// A reader's issued source file read can still be in flight when its terminal exits.
vi.mock('../../storage/terminal-history-file-reader', async (importOriginal) => {
  const actual = await importOriginal<typeof FileReaderModule>()
  return {
    ...actual,
    readTerminalHistoryBufferAsync: async (
      ...args: Parameters<typeof actual.readTerminalHistoryBufferAsync>
    ) => {
      await sourceRead.during()
      return actual.readTerminalHistoryBufferAsync(...args)
    }
  }
})

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  sourceRead.during = async () => {}
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Real host owner: its 64 MiB aggregate counts every writer and the reader's frozen-only part. */
async function openHost() {
  const root = mkdtempSync(join(tmpdir(), 'orca-host-pressure-'))
  roots.push(root)
  const journals = new TerminalHistoryJournals(root)
  let sequence = 0
  const open = async (sessionId: string): Promise<TerminalSessionJournal> => {
    const hold = await journals.prepareHold(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
    const journal = journals.openJournal(hold, {
      cwd: '/tmp',
      cols: 80,
      rows: 24,
      wslDistro: undefined
    })
    journal.bindSession({
      incarnationId: `${sessionId}-incarnation`,
      historySeeded: undefined,
      isAlive: true,
      settleShellOwnershipConfirmation: async () => {},
      snapshotBarrier: () => {},
      prepareForFinalSnapshot: () => ''
    })
    journal.bindOutput({
      outputSequence: () => sequence,
      terminalOwner: () => undefined,
      hasAttachedClient: () => false
    })
    journal.record({ kind: 'output', data: 'PRIME\r\n' })
    await journal.flush()
    return journal
  }
  // Full 64 Ki-unit records, 65,541 bytes each: 120 of them stay under the 8 MiB session bound.
  const fill = (journal: TerminalSessionJournal, marker: string, count = 120): void => {
    for (let index = 0; index < count; index += 1) {
      const head = `${marker}_${String(index).padStart(3, '0')}_`
      sequence += 65_536
      journal.record({ kind: 'output', data: `${head}${'q'.repeat(65_536 - head.length)}` })
    }
  }
  return { journals, open, fill }
}

async function readThrough(
  reads: TerminalHistoryReads,
  journal: TerminalSessionJournal
): Promise<string | null> {
  const consumer = reads.admit(new AbortController().signal)!
  try {
    const found = await consumer.acquire(journal, 5000, async () => {})
    const ready =
      found === 'image' ||
      (found !== null && found.capture() && (await consumer.awaitFlight(found)))
    const image = consumer.image
    return ready && image ? `${image.snapshot.scrollbackAnsi}${image.snapshot.snapshotAnsi}` : null
  } finally {
    consumer.release()
  }
}

describe('host-wide read pressure', () => {
  // CR3 at the host: a reader keeps its committed prefix charged; another writer's growth
  // revokes that reader before any healthy writer is gapped.
  it('revokes a committed frozen read before a healthy writer crosses 64 MiB', async () => {
    const { journals, open, fill } = await openHost()
    const reader = await open('host-reader')
    const writers: TerminalSessionJournal[] = []
    for (let index = 0; index < 8; index += 1) {
      writers.push(await open(`host-writer-${index}`))
    }
    const appends = gateAppends()
    // 70 records (4.6 MB) commit without reaching the 5 MiB log cap, so no fold waits on the read.
    fill(reader, 'READER', 70)
    const reconstruction = gateReconstruction(reader)
    const severed = readThrough(journals.reads, reader)
    await vi.waitFor(() => expect(reconstruction.calls).toHaveBeenCalledTimes(1))
    // Shared with the writer's own queue: admitted without a second charge.
    expect(journals.reads.readSourceBytes).toBe(0)
    appends.open()
    await reader.flush()
    expect(journals.reads.readSourceBytes).toBe(70 * 65_541)
    appends.close()

    for (const [index, writer] of writers.entries()) {
      fill(writer, `WRITER${index}`)
    }
    // Eight writers (62.9 MB) fit the 64 MiB host alone; with the reader's 4.6 MB they do not.
    expect(journals.reads.readSourceBytes).toBe(0)
    reconstruction.open()
    expect(await severed).toBeNull()
    expect([reader, ...writers].some((journal) => journal.gapped)).toBe(false)

    // Both healthy journals still answer exactly: the writer from pending, the reader from disk.
    expect(await readThrough(journals.reads, writers[7]!)).toContain('WRITER7_119_')
    expect(await readThrough(journals.reads, reader)).toContain('READER_069_')
  }, 120_000)

  // A same-ID start prepares over the predecessor's files only once a read it issued has ended.
  it('keeps an exited journal unsettled until its acquired read actually ends', async () => {
    const { journals, open } = await openHost()
    const sessionId = 'read-across-exit'
    const old = await open(sessionId)
    old.record({ kind: 'output', data: 'OLD_ROW\r\n' })
    expect(await old.flush()).toBe(true)
    const reading = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    sourceRead.during = async () => {
      reading.resolve()
      await release.promise
    }
    const read = readThrough(journals.reads, old)
    // Sync point only: the read holds its replay lease and its source read is issued.
    await reading.promise
    sourceRead.during = async () => {}
    let settled = false
    void old.settled.then(() => {
      settled = true
    })
    old.finish(0)
    // The final pump, its clean end included, has finished.
    await old.flush()

    expect(settled).toBe(false)
    release.resolve()
    expect(await read).toContain('OLD_ROW')
    await old.settled
    const hold = await journals.prepareHold(sessionId, { cwd: '/tmp', cols: 80, rows: 24 })
    expect(hold.preservesRecovery).toBe(false)
  }, 30_000)
})
