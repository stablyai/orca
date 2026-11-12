import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  promises as fsPromises,
  readFileSync,
  rmSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalSessionJournal } from '../terminal-session-journal'
import { DerivedHistoryImageBudget } from '../terminal-history-derived-image'
import { getHistorySessionDirName } from '../../storage/history-paths'
import { HistoryReader } from '../../restoration/history-reader'
import { TerminalHistorySessionWriter } from '../../storage/terminal-history-session-writer'
import {
  newTerminalHistoryMeta,
  writeTerminalHistoryMeta
} from '../../storage/terminal-history-metadata'

const roots: string[] = []

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function openJournal(
  sessionId: string,
  opts: { preservesRecovery?: boolean; seed?: string } = {}
): { journal: TerminalSessionJournal; root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-journal-'))
  roots.push(root)
  const dirName = getHistorySessionDirName(sessionId)
  const dir = join(root, dirName)
  mkdirSync(dir, { recursive: true })
  const journal = new TerminalSessionJournal(
    {
      acquireReplay: async () => () => {},
      images: new DerivedHistoryImageBudget(),
      charge: () => {},
      makeRoom: () => {},
      settled: () => {},
      log: () => {}
    },
    root,
    dirName,
    { cwd: '/tmp', cols: 80, rows: 24, wslDistro: undefined, preservesRecovery: false, ...opts }
  )
  return { journal, root, dir }
}

function bind(journal: TerminalSessionJournal, historySeeded?: boolean): void {
  journal.bindSession({
    incarnationId: 'incarnation-1',
    historySeeded,
    isAlive: true,
    settleShellOwnershipConfirmation: async () => {},
    snapshotBarrier: () => {},
    prepareForFinalSnapshot: () => ''
  })
  journal.bindOutput({
    outputSequence: () => 0,
    terminalOwner: () => undefined,
    hasAttachedClient: () => false
  })
}

const output = (data: string) => ({ kind: 'output' as const, data })

describe('TerminalSessionJournal', () => {
  // CJ1: later output coalesced into the queued tail used to leak into an earlier attach cut.
  it('keeps a cut exact while later output coalesces into its queued tail', async () => {
    const { journal } = openJournal('journal-cut')
    bind(journal)
    journal.record(output('COMMITTED\r\n'))
    expect(await journal.flush()).toBe(true)
    journal.record(output('AT_CUT\r\n'))
    const cut = journal.captureReadCut()
    journal.record(output('AFTER_CUT\r\n'))

    const image = await journal.readImage(cut)
    expect(image?.snapshot.snapshotAnsi).toContain('COMMITTED')
    expect(image?.snapshot.snapshotAnsi).toContain('AT_CUT')
    expect(image?.snapshot.snapshotAnsi).not.toContain('AFTER_CUT')
    expect(await journal.flush()).toBe(true)
  })

  // CJ3: a seeded origin used to delete the predecessor before its own replacement was durable.
  it('keeps the predecessor recovery when the seed replacement fails to publish', async () => {
    const sessionId = 'journal-seeded'
    const { journal, root, dir } = openJournal(sessionId, { preservesRecovery: true })
    writeTerminalHistoryMeta(dir, newTerminalHistoryMeta({ cwd: '/tmp', cols: 80, rows: 24 }, null))
    await new TerminalHistorySessionWriter(dir, true).appendIncrements(1, [
      output('PREDECESSOR_ROW\r\n')
    ])
    const writeFile = fsPromises.writeFile
    vi.spyOn(fsPromises, 'writeFile').mockImplementation((path, ...rest) =>
      String(path).endsWith('checkpoint.json.tmp')
        ? Promise.reject(new Error('ENOSPC'))
        : writeFile(path, ...rest)
    )

    journal.record(output('SEED_ROW\r\n'), { origin: true })
    bind(journal, true)
    await vi.waitFor(() => expect(journal.gapped).toBe(true))

    const restored = await new HistoryReader(root).detectColdRestore(sessionId)
    expect(restored?.snapshotAnsi).toContain('PREDECESSOR_ROW')
  })

  // CJ12: a second fold used to drop the cwd the first fold's checkpoint carried.
  it('keeps the checkpoint cwd across folds while a later OSC 7 still wins', async () => {
    const sessionId = 'journal-fold-cwd'
    const { journal, root, dir } = openJournal(sessionId)
    bind(journal)
    journal.record(output('\x1b]7;file://host/tmp/cwd-a\x07CWD_A_ROW\r\n'))
    const sgrFlood = '\x1b[0m'.repeat(16_384)
    const readGeneration = () => JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8'))
    for (const folds of [1, 2]) {
      while (!existsSync(join(dir, 'checkpoint.json')) || readGeneration().generation < folds) {
        for (let chunk = 0; chunk < 16; chunk += 1) {
          journal.record(output(sgrFlood))
        }
        expect(await journal.flush()).toBe(true)
      }
    }
    expect(readGeneration().cwd).toBe('/tmp/cwd-a')

    journal.record(output('\x1b]7;file://host/tmp/cwd-c\x07CWD_C_ROW\r\n'))
    const image = await journal.readImage(journal.captureReadCut(), { scrollbackRows: 5000 })
    expect(image?.snapshot.cwd).toBe('/tmp/cwd-c')
    expect(await journal.flush()).toBe(true)
    const restored = await new HistoryReader(root).detectColdRestore(sessionId)
    expect(restored?.cwd).toBe('/tmp/cwd-c')
    expect(`${restored?.scrollbackAnsi}${restored?.snapshotAnsi}`).toContain('CWD_A_ROW')
  }, 60_000)

  // PF1 perf contract: separate callbacks spaced 10 ms apart, each after the previous append settled.
  // Appends are bounded by one per 1 s window plus the opening append and the forced final one.
  it.each([1_000, 10_000])(
    'appends %i spaced callbacks at most once per window',
    async (count) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { journal, dir } = openJournal(`journal-cadence-${count}`)
      bind(journal)
      const inFlight: Promise<void>[] = []
      const appendFile = fsPromises.appendFile
      const appends = vi.spyOn(fsPromises, 'appendFile').mockImplementation((...args) => {
        const write = appendFile(...args)
        inFlight.push(write)
        return write
      })
      for (let index = 0; index < count; index += 1) {
        journal.record(output(`${'x'.repeat(30)}\r\n`))
        await vi.advanceTimersByTimeAsync(10)
        await Promise.all(inFlight.splice(0))
      }
      journal.record(output('EXIT_MARKER\r\n'))
      // Physical exit must not wait for the window: no timer advances past this point.
      journal.finish(0)
      await journal.settled

      expect(readFileSync(join(dir, 'output.log')).includes('EXIT_MARKER')).toBe(true)
      expect(appends.mock.calls.length).toBeLessThanOrEqual(Math.ceil((count * 10) / 1000) + 2)
    },
    60_000
  )
})
