import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { OrchestrationDbCompaction } from './orchestration-db-compaction'

const dirs: string[] = []

/** A real orchestration database as an older build left it: no auto-vacuum, `freedMiB` of free pages. */
function legacyDatabase(freedMiB = 40, keptMiB = 8): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-orchestration-compaction-'))
  dirs.push(dir)
  const file = join(dir, 'orchestration.db')
  const orchestration = new OrchestrationDb(file)
  orchestration.createTask({ runId: 'run_legacy_local', spec: 'kept' })
  orchestration.close()
  const db = new DatabaseSync(file)
  db.exec('PRAGMA auto_vacuum = NONE; VACUUM; CREATE TABLE qa_filler (body BLOB)')
  const insert = db.prepare('INSERT INTO qa_filler (body) VALUES (randomblob(1048576))')
  db.exec('BEGIN')
  for (let i = 0; i < keptMiB + freedMiB; i++) {
    insert.run()
  }
  db.exec('COMMIT')
  db.prepare('DELETE FROM qa_filler WHERE rowid > ?').run(keptMiB)
  db.close()
  return file
}

function inspect(file: string): { autoVacuum: number; integrity: string; tasks: number } {
  const db = new DatabaseSync(file)
  try {
    return {
      autoVacuum: Number(db.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum),
      integrity: String(db.prepare('PRAGMA integrity_check').get()!.integrity_check),
      tasks: Number(db.prepare('SELECT count(*) AS n FROM tasks').get()!.n)
    }
  } finally {
    db.close()
  }
}

/** The runtime's connection, with a compacted copy taken after one quiet maintenance minute. */
async function copiedWhileQuiet(file: string): Promise<{
  orchestration: OrchestrationDb
  compaction: OrchestrationDbCompaction
}> {
  const orchestration = new OrchestrationDb(file)
  const compaction = new OrchestrationDbCompaction(orchestration, file, () => true, 1)
  await compaction.tick()
  await compaction.tick()
  expect(existsSync(`${file}-compacted`)).toBe(true)
  return { orchestration, compaction }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('OrchestrationDbCompaction', () => {
  it('swaps in a copy taken while the file sat unwritten, switched to incremental', async () => {
    const file = legacyDatabase()
    const before = statSync(file).size
    const { compaction } = await copiedWhileQuiet(file)

    const result = await compaction.swapAtQuit(async () => {})

    expect(result.kind).toBe('compacted')
    expect(statSync(file).size).toBeLessThan(before / 4)
    expect(existsSync(`${file}-wal`)).toBe(false)
    expect(existsSync(`${file}-shm`)).toBe(false)
    expect(inspect(file)).toEqual({ autoVacuum: 2, integrity: 'ok', tasks: 1 })
    expect(existsSync(`${file}-replaced`)).toBe(false)
  })

  it('keeps the original when anything was written after the copy', async () => {
    const file = legacyDatabase()
    const { orchestration, compaction } = await copiedWhileQuiet(file)
    orchestration.createTask({ runId: 'run_legacy_local', spec: 'written after the copy' })

    expect(await compaction.swapAtQuit(async () => {})).toEqual({ kind: 'stale' })

    expect(inspect(file)).toEqual({ autoVacuum: 0, integrity: 'ok', tasks: 2 })
    expect(existsSync(`${file}-compacted`)).toBe(false)
  })

  it('waits longer after each copy that went stale, and gives up after three', async () => {
    const hour = 60 * 60_000
    const now = Date.UTC(2026, 10, 20)
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const copiesAfter = async (attempts: string): Promise<boolean> => {
      const file = legacyDatabase()
      writeFileSync(`${file}-compaction-attempts`, attempts)
      const orchestration = new OrchestrationDb(file)
      const compaction = new OrchestrationDbCompaction(orchestration, file, () => true, 1)
      await compaction.tick()
      await compaction.tick()
      const copied = existsSync(`${file}-compacted`)
      compaction.stop()
      orchestration.close()
      return copied
    }

    expect(await copiesAfter(`1 ${now - 0.5 * hour}`)).toBe(false)
    expect(await copiesAfter(`1 ${now - 1.5 * hour}`)).toBe(true)
    expect(await copiesAfter(`2 ${now - 1.5 * hour}`)).toBe(false)
    expect(await copiesAfter(`2 ${now - 2.5 * hour}`)).toBe(true)
    expect(await copiesAfter(`3 ${now - 25 * hour}`)).toBe(false)
    // A third copy still marked in flight (its outcome never recorded) counts.
    expect(await copiesAfter(`2 ${now - 25 * hour} 3`)).toBe(false)
  })

  it('swaps in a copy after a burst left a drained WAL over 8 MiB', async () => {
    const file = legacyDatabase()
    const orchestration = new OrchestrationDb(file)
    orchestration.db.exec('PRAGMA wal_autocheckpoint = 0; BEGIN')
    for (let i = 0; i < 10; i++) {
      orchestration.db.exec('INSERT INTO qa_filler (body) VALUES (randomblob(1048576))')
    }
    orchestration.db.exec('COMMIT; PRAGMA wal_checkpoint(PASSIVE)')
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(8 * 1024 * 1024)
    const compaction = new OrchestrationDbCompaction(orchestration, file, () => true, 1)
    await compaction.tick()
    await compaction.tick()

    expect((await compaction.swapAtQuit(async () => {})).kind).toBe('compacted')
    expect(inspect(file)).toEqual({ autoVacuum: 2, integrity: 'ok', tasks: 1 })
  })

  it('leaves no WAL behind when the runtime closes the file it is watching', async () => {
    const file = legacyDatabase()
    const orchestration = new OrchestrationDb(file)
    orchestration.createTask({ runId: 'run_legacy_local', spec: 'written this session' })
    const compaction = new OrchestrationDbCompaction(orchestration, file, () => true)
    await compaction.tick()

    orchestration.close()

    expect(existsSync(`${file}-wal`)).toBe(false)
  })

  it('removes a copy still being written when the app quits', async () => {
    // Enough live data that the copy is still running when its file appears.
    const file = legacyDatabase(8, 96)
    const orchestration = new OrchestrationDb(file)
    const compaction = new OrchestrationDbCompaction(orchestration, file, () => true, 1)
    await compaction.tick()
    const copying = compaction.tick()
    await vi.waitFor(() => expect(existsSync(`${file}-compacted`)).toBe(true), { interval: 5 })
    expect(compaction.hasCopy).toBe(false)

    await compaction.discardUnfinishedCopy()
    await copying
    orchestration.close()

    expect(existsSync(`${file}-compacted`)).toBe(false)
    expect(existsSync(`${file}-compacted-journal`)).toBe(false)
  })

  it('converts a legacy file with little free space', async () => {
    const file = legacyDatabase(1)
    const { compaction } = await copiedWhileQuiet(file)

    expect((await compaction.swapAtQuit(async () => {})).kind).toBe('compacted')
    expect(inspect(file)).toEqual({ autoVacuum: 2, integrity: 'ok', tasks: 1 })
  })

  it('leaves the file alone while another connection has it open', async () => {
    const file = legacyDatabase()
    const { compaction } = await copiedWhileQuiet(file)
    const other = new DatabaseSync(file)
    other.prepare('SELECT count(*) FROM tasks').get()

    expect(await compaction.swapAtQuit(async () => {})).toEqual({ kind: 'busy' })
    other.close()

    expect(inspect(file)).toEqual({ autoVacuum: 0, integrity: 'ok', tasks: 1 })
  })

  it("swaps in a copy when only the runtime's TEMP tables were written since", async () => {
    const file = legacyDatabase()
    const { orchestration, compaction } = await copiedWhileQuiet(file)
    orchestration.db.exec('CREATE TEMP TABLE scratch (x); INSERT INTO scratch VALUES (1)')

    expect((await compaction.swapAtQuit(async () => {})).kind).toBe('compacted')
    expect(inspect(file).autoVacuum).toBe(2)
  })

  it('refuses a write through a kept reference while the swap is under way', async () => {
    const file = legacyDatabase()
    const { orchestration, compaction } = await copiedWhileQuiet(file)
    let late: unknown = 'not attempted'

    const result = await compaction.swapAtQuit(async () => {
      // As a caller that kept the connection across an await would write.
      setImmediate(() => {
        try {
          late = orchestration.createTask({ runId: 'run_legacy_local', spec: 'during the swap' })
        } catch (error) {
          late = error
        }
      })
    })

    expect(result.kind).toBe('compacted')
    expect(late).toBeInstanceOf(Error)
    expect(inspect(file)).toEqual({ autoVacuum: 2, integrity: 'ok', tasks: 1 })
  })
})
