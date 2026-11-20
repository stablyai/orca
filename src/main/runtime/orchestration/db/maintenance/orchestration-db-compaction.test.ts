import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { OrchestrationDbCompaction } from './orchestration-db-compaction'

const dirs: string[] = []

/** A real orchestration database as an older build left it: no auto-vacuum, `freedMiB` of free pages. */
function legacyDatabase(): string {
  const keptMiB = 8
  const freedMiB = 40
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
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('OrchestrationDbCompaction', () => {
  it('swaps in a copy taken while the file sat unwritten, switched to incremental', async () => {
    const file = legacyDatabase()
    const before = statSync(file).size
    const { orchestration, compaction } = await copiedWhileQuiet(file)

    const result = await compaction.swapAtQuit(() => orchestration.close())

    expect(result.kind).toBe('compacted')
    expect(statSync(file).size).toBeLessThan(before / 4)
    expect(inspect(file)).toEqual({ autoVacuum: 2, integrity: 'ok', tasks: 1 })
    expect(existsSync(`${file}-replaced`)).toBe(false)
  })

  it('keeps the original when anything was written after the copy', async () => {
    const file = legacyDatabase()
    const { orchestration, compaction } = await copiedWhileQuiet(file)
    orchestration.createTask({ runId: 'run_legacy_local', spec: 'written after the copy' })

    expect(await compaction.swapAtQuit(() => orchestration.close())).toEqual({ kind: 'stale' })
    orchestration.close()

    expect(inspect(file)).toEqual({ autoVacuum: 0, integrity: 'ok', tasks: 2 })
    expect(existsSync(`${file}-compacted`)).toBe(false)
  })
})
