import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryReader } from '../../restoration/history-reader'
import { getHistorySessionDirName } from '../../storage/history-paths'
import { encodeLogHeader } from '../../storage/terminal-history-log'
import { TerminalHistorySessionWriter } from '../../storage/terminal-history-session-writer'
import {
  newTerminalHistoryMeta,
  replaceTerminalHistoryMetaOwned,
  writeTerminalHistoryMeta
} from '../../storage/terminal-history-metadata'
import { publishTerminalJournalSeedOrigin } from '../terminal-session-journal-source'
import type { TerminalSessionJournal } from '../terminal-session-journal'
import type { TerminalJournalOperation } from '../terminal-journal-operation'
import { gateAppends, openReads, removeReadFixtureRoots } from './terminal-history-read-fixture'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  removeReadFixtureRoots()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const osc7 = (path: string): string => `\x1b]7;file://host${path}\x07`

function admit(
  journal: TerminalSessionJournal,
  kind: 'commit' | 'sleep',
  cwd?: string
): TerminalJournalOperation {
  const operation = journal.admitOperation(kind, cwd)
  if (typeof operation === 'string') {
    throw new Error(`refused: ${operation}`)
  }
  return operation
}

/** What a cold restore of these saved files shows; no journal, parser or daemon state is read. */
async function restoreFromDisk(journal: TerminalSessionJournal, sessionId: string) {
  const root = join(journal.dir, '..')
  return new HistoryReader(root).detectColdRestore(sessionId, { ignoreCleanEnd: true })
}

describe('ordered saved folder note', () => {
  // A probed folder must survive a crash even while the shell sits inside an unfinished sequence.
  it.each([
    ['an unfinished CSI', '\x1b[31'],
    ['an unfinished OSC title', '\x1b]0;half-a-title'],
    ['a dangling high surrogate', '\ud83d']
  ])(
    'restores the probed folder over an earlier OSC 7 when output stops in %s',
    async (_, tail) => {
      const { openJournal, record, prime } = openReads()
      const sessionId = 'note-partial'
      const journal = openJournal(sessionId)
      await prime(journal)
      record(journal, `${osc7('/tmp/folder-a')}FIRST_ROW\r\nSECOND_ROW\r\n${tail}`)
      const probed = `/tmp/${'deep/'.repeat(1000)}folder-b`
      const commit = admit(journal, 'commit', probed)

      expect(await commit.publication.promise).not.toBeNull()
      // The daemon dies here: nothing finishes, flushes or folds after the commit receipt.
      const restored = await restoreFromDisk(journal, sessionId)
      expect(probed.length).toBeGreaterThan(4096)
      expect(restored?.cwd).toBe(probed)
      expect(restored?.snapshotAnsi).toContain('FIRST_ROW')
      expect(restored?.snapshotAnsi).toContain('SECOND_ROW')
    }
  )

  it('lets a later real OSC 7 win, even repeating the earlier folder or split across the note', async () => {
    const { openJournal, record, prime } = openReads()
    const journal = openJournal('note-later')
    await prime(journal)
    record(journal, `${osc7('/tmp/folder-a')}A_ROW\r\n`)
    await admit(journal, 'commit', '/tmp/folder-b').publication.promise
    record(journal, `${osc7('/tmp/folder-a')}REPEAT_ROW\r\n`)
    expect(await journal.flush()).toBe(true)
    expect((await restoreFromDisk(journal, 'note-later'))?.cwd).toBe('/tmp/folder-a')

    // An OSC 7 that began before a newer note and finished after it is the later event.
    record(journal, '\x1b]7;file://host/tmp/folder-split')
    await admit(journal, 'commit', '/tmp/folder-c').publication.promise
    record(journal, '\x07SPLIT_ROW\r\n')
    expect(await journal.flush()).toBe(true)
    expect((await restoreFromDisk(journal, 'note-later'))?.cwd).toBe('/tmp/folder-split')
  })

  it('ends its batch at the note, so later output queued in the same turn still wins', async () => {
    const { openJournal, record, prime } = openReads()
    const journal = openJournal('note-aligned')
    await prime(journal)
    record(journal, `${osc7('/tmp/folder-a')}A_ROW\r\n`)
    const commit = admit(journal, 'commit', '/tmp/folder-b')
    record(journal, `${osc7('/tmp/folder-x')}X_ROW\r\n`)

    expect(await commit.publication.promise).not.toBeNull()
    expect(await journal.flush()).toBe(true)
    expect((await restoreFromDisk(journal, 'note-aligned'))?.cwd).toBe('/tmp/folder-x')
  })

  it('backs a silent shell that changed folder with an empty batch at its origin', async () => {
    const { openJournal } = openReads()
    const journal = openJournal('note-empty')
    const position = await admit(journal, 'commit', '/tmp/silent-b').publication.promise

    expect(position).toEqual({ generation: 0, logBytes: 18 })
    const restored = await restoreFromDisk(journal, 'note-empty')
    expect(restored?.cwd).toBe('/tmp/silent-b')
    expect([restored?.cols, restored?.rows]).toEqual([80, 24])
  })

  it('keeps a WSL folder literal, drvfs and long UNC spellings included', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      for (const probed of [
        '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\work',
        `\\\\wsl.localhost\\Ubuntu\\home\\${'nested\\'.repeat(600)}leaf`
      ]) {
        const { openJournal, record, prime } = openReads()
        const journal = openJournal('note-wsl')
        await prime(journal)
        record(journal, 'WSL_ROW\r\n')
        await admit(journal, 'commit', probed).publication.promise
        expect((await restoreFromDisk(journal, 'note-wsl'))?.cwd).toBe(probed)
      }
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('reports a malformed probe as rejected and saves no folder for it', async () => {
    const { openJournal, record, prime } = openReads()
    const journal = openJournal('note-rejected')
    await prime(journal)
    record(journal, `${osc7('/tmp/folder-a')}ROW\r\n`)
    const commit = admit(journal, 'commit', 'relative/folder')

    expect(await commit.publication.promise).not.toBeNull()
    expect(commit.cwdNote).toBe('rejected')
    expect((await restoreFromDisk(journal, 'note-rejected'))?.cwd).toBe('/tmp/folder-a')
  })
})

describe('one admitted operation and its source lineage', () => {
  it('refuses an overlapping operation, keeps older reads before the note, then admits again', async () => {
    const { openJournal, record, prime } = openReads()
    const journal = openJournal('note-busy')
    await prime(journal)
    record(journal, `${osc7('/tmp/folder-a')}BUSY_ROW\r\n`)
    const older = journal.captureReadCut()
    const appends = gateAppends()
    const first = admit(journal, 'commit', '/tmp/folder-b')

    expect(journal.admitOperation('commit', '/tmp/folder-c')).toBe('busy')
    const image = await journal.readImage(older, { scrollbackRows: 5000 })
    expect(image?.snapshot.cwd).toBe('/tmp/folder-a')
    appends.open()
    expect(await first.publication.promise).not.toBeNull()
    await admit(journal, 'commit', '/tmp/folder-c').publication.promise
    expect((await restoreFromDisk(journal, 'note-busy'))?.cwd).toBe('/tmp/folder-c')
  })

  // A failed reset under the predecessor's metadata never pairs its old bytes with new geometry.
  it('starts no new origin over obsolete files it could not remove', async () => {
    const { openJournal, record } = openReads()
    const journal = openJournal('origin-refused')
    writeTerminalHistoryMeta(
      journal.dir,
      newTerminalHistoryMeta({ cwd: '/tmp', cols: 132, rows: 40 }, null)
    )
    // A directory where the old log was cannot be unlinked as a file.
    mkdirSync(join(journal.dir, 'output.log'))
    record(journal, 'NEW_ROW\r\n')
    await vi.waitFor(() => expect(journal.gapped).toBe(true))

    const meta = JSON.parse(readFileSync(join(journal.dir, 'meta.json'), 'utf8'))
    expect([meta.cols, meta.rows]).toEqual([132, 40])
    expect(readdirSync(journal.dir).sort()).toEqual(['meta.json', 'output.log'])
  })

  it('drops a predecessor note when a successor starts its own origin', async () => {
    const { openJournal, record, prime } = openReads()
    const predecessor = openJournal('origin-successor')
    await prime(predecessor)
    await admit(predecessor, 'commit', '/tmp/predecessor-b').publication.promise
    // The successor's hold keeps the predecessor's metadata, note included.
    const held = readFileSync(join(predecessor.dir, 'meta.json'), 'utf8')
    const successor = openJournal('origin-successor')
    writeFileSync(join(successor.dir, 'meta.json'), held)
    record(successor, `${osc7('/tmp/successor')}SUCCESSOR_ROW\r\n`)
    expect(await successor.flush()).toBe(true)

    const restored = await restoreFromDisk(successor, 'origin-successor')
    expect(restored?.cwd).toBe('/tmp/successor')
    expect(restored?.snapshotAnsi).not.toContain('PRIME')
  })

  it('seeds above a readable newer checkpoint beside an older header', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-seed-lineage-'))
    roots.push(root)
    const dir = join(root, getHistorySessionDirName('seed-lineage'))
    mkdirSync(dir, { recursive: true })
    writeTerminalHistoryMeta(dir, {
      ...newTerminalHistoryMeta({ cwd: '/tmp', cols: 80, rows: 24 }, null),
      cwdObservation: { cwd: '/tmp/predecessor-b', generation: 2, logBytes: 9 }
    })
    const predecessor = new TerminalHistorySessionWriter(dir, true)
    for (let generation = 0; generation < 3; generation += 1) {
      await predecessor.checkpoint(
        { ...emptySnapshot(), snapshotAnsi: 'OLD_ROW' },
        { pendingOutputSeq: 0 }
      )
    }
    // An interrupted reset left a whole header two generations older than the checkpoint.
    writeFileSync(join(dir, 'output.log'), encodeLogHeader(1))

    const writer = await publishTerminalJournalSeedOrigin(
      dir,
      { cwd: '/tmp', cols: 80, rows: 24, wslDistro: undefined },
      [{ kind: 'output', data: 'SEED_ROW\r\n' }],
      () => true
    )

    expect(writer.committedLog?.generation).toBe(4)
    expect(JSON.parse(readFileSync(join(dir, 'checkpoint.json'), 'utf8')).generation).toBe(4)
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
    expect(meta.cwdObservation).toBeUndefined()
    const restored = await new HistoryReader(root).detectColdRestore('seed-lineage')
    expect(restored?.snapshotAnsi).toContain('SEED_ROW')
    expect(restored?.cwd).toBe('/tmp')
  })

  it('keeps the published metadata when its owner changes before the rename', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-meta-owner-'))
    roots.push(root)
    writeTerminalHistoryMeta(
      root,
      newTerminalHistoryMeta({ cwd: '/tmp', cols: 80, rows: 24 }, null)
    )
    const before = readFileSync(join(root, 'meta.json'), 'utf8')
    let checks = 0

    const result = replaceTerminalHistoryMetaOwned(
      root,
      (meta) => ({ ...meta, cwdObservation: { cwd: '/tmp/b', generation: 0, logBytes: 18 } }),
      () => (checks += 1) === 1
    )

    expect(result).toBe('unavailable')
    expect(readFileSync(join(root, 'meta.json'), 'utf8')).toBe(before)
    expect(readdirSync(root)).toEqual(['meta.json'])
  })
})

describe('Sleep preflight and final cut', () => {
  const flood = '\x1b[0m'.repeat(16_384)

  // K: the committed source at the lease, which a complete fold may already have replaced.
  it('verifies the source a covering fold published while the preflight waited', async () => {
    const { openJournal, record, prime, replay } = openReads()
    const journal = openJournal('sleep-fold')
    await prime(journal)
    record(journal, `${osc7('/tmp/folder-a')}BEFORE_FOLD\r\n`)
    const sleep = admit(journal, 'sleep', '/tmp/folder-b')
    expect(await sleep.publication.promise).not.toBeNull()
    const acquire = vi.spyOn(replay, 'acquire')
    const hold = await replay.acquire(0)
    const preflight = journal.preflightSleep(sleep)
    for (let chunk = 0; chunk < 96; chunk += 1) {
      record(journal, flood)
    }
    record(journal, 'AFTER_FOLD\r\n')
    const flushed = journal.flush()
    // Sync point only: the log cap's fold is waiting behind the same lease as the preflight.
    await vi.waitFor(() =>
      expect(acquire.mock.calls.some(([priority]) => priority === 0)).toBe(true)
    )
    hold()

    expect(await preflight).toBe(true)
    expect(await flushed).toBe(true)
    expect(journal.admitOperation('commit', undefined)).toBe('busy')
    const generation = JSON.parse(readFileSync(join(journal.dir, 'checkpoint.json'), 'utf8'))
    expect(generation.cwd).toBe('/tmp/folder-b')
    const restored = await restoreFromDisk(journal, 'sleep-fold')
    expect(restored?.cwd).toBe('/tmp/folder-b')
    expect(restored?.snapshotAnsi).toContain('AFTER_FOLD')
  }, 30_000)

  it('never kills for a canceled preflight and frees its slot once the read settles', async () => {
    const { openJournal, record, prime, replay } = openReads()
    const journal = openJournal('sleep-canceled')
    await prime(journal)
    record(journal, 'ROW\r\n')
    const sleep = admit(journal, 'sleep')
    await sleep.publication.promise
    const hold = await replay.acquire(0)
    const preflight = journal.preflightSleep(sleep)
    journal.cancelSleep(sleep)
    hold()

    expect(await preflight).toBe(false)
    expect(await sleep.outcome.promise).toEqual({ phase: 'preflight', reason: 'canceled' })
    await admit(journal, 'commit').publication.promise
    // Never authorized: a later ordinary exit still ends the history cleanly.
    journal.finish(0, physicalExit(7))
    await journal.settled
    expect(JSON.parse(readFileSync(join(journal.dir, 'meta.json'), 'utf8')).endedAt).not.toBeNull()
  })

  it.each([
    ['a strict final checkpoint', 'checkpoint'],
    ['the complete raw source, when one image cannot fit', 'raw']
  ] as const)('publishes the physical final cut as %s', async (_, backing) => {
    const { openJournal, record, prime } = openReads()
    const journal = openJournal(`sleep-final-${backing}`)
    await prime(journal)
    record(journal, `${osc7('/tmp/folder-a')}BEFORE_SLEEP\r\n`)
    const sleep = admit(journal, 'sleep', '/tmp/folder-b')
    expect(await journal.preflightSleep(sleep)).toBe(true)
    journal.authorizeSleep(sleep)
    if (backing === 'raw') {
      vi.spyOn(TerminalHistorySessionWriter.prototype, 'checkpointStrict').mockResolvedValue({
        result: 'too-large'
      })
    }
    // Termination-time output, including a real OSC 7 the final Sleep probe still overrides.
    record(journal, `${osc7('/tmp/folder-c')}DURING_TERMINATION\r\n`)
    journal.finish(0, physicalExit(4242))

    const receipt = await sleep.outcome.promise
    expect(receipt).toMatchObject({ backing, outputSequence: 4242 })
    const meta = JSON.parse(readFileSync(join(journal.dir, 'meta.json'), 'utf8'))
    expect(meta.endedAt).toBeNull()
    const restored = await restoreFromDisk(journal, `sleep-final-${backing}`)
    expect(restored?.cwd).toBe('/tmp/folder-b')
    expect(restored?.snapshotAnsi).toContain('BEFORE_SLEEP')
    expect(restored?.snapshotAnsi).toContain('DURING_TERMINATION')
  })

  it('gives no receipt or clean end when only a disposal, not a physical exit, ends it', async () => {
    const { openJournal, record, prime } = openReads()
    const journal = openJournal('sleep-disposed')
    await prime(journal)
    record(journal, 'ROW\r\n')
    const sleep = admit(journal, 'sleep')
    expect(await journal.preflightSleep(sleep)).toBe(true)
    journal.authorizeSleep(sleep)
    journal.finish(null)

    expect(await sleep.outcome.promise).toEqual({ phase: 'authorized', reason: 'gap' })
    await journal.settled
    expect(JSON.parse(readFileSync(join(journal.dir, 'meta.json'), 'utf8')).endedAt).toBeNull()
  })

  it('keeps the readable prefix when no strict image of the retained window fits', async () => {
    const { openJournal, record, prime } = openReads()
    const journal = openJournal('fold-exhausted')
    await prime(journal)
    record(journal, 'EARLY_ROW\r\n')
    expect(await journal.flush()).toBe(true)
    vi.spyOn(TerminalHistorySessionWriter.prototype, 'checkpointStrict').mockResolvedValue({
      result: 'too-large'
    })
    for (let chunk = 0; chunk < 96; chunk += 1) {
      record(journal, flood)
    }
    await journal.flush()

    expect(journal.gapped).toBe(true)
    const restored = await restoreFromDisk(journal, 'fold-exhausted')
    expect(restored?.snapshotAnsi).toContain('EARLY_ROW')
  }, 30_000)
})

function physicalExit(outputSequence: number) {
  return { outputSequence, settled: Promise.resolve({ terminalOwner: undefined }) }
}

function emptySnapshot() {
  return {
    snapshotAnsi: '',
    scrollbackAnsi: '',
    rehydrateSequences: '',
    cwd: null,
    modes: {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    },
    cols: 80,
    rows: 24,
    scrollbackLines: 0
  }
}
