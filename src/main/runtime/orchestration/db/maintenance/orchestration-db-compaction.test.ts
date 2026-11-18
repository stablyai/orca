import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { compactOrchestrationDbOnce } from './orchestration-db-compaction'

const dirs: string[] = []

/** A pre-incremental WAL file holding `keptMiB` of rows after `freedMiB` were deleted. */
function legacyDatabase(keptMiB: number, freedMiB: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-orchestration-compaction-'))
  dirs.push(dir)
  const file = join(dir, 'orchestration.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE rows (id INTEGER PRIMARY KEY, body BLOB)')
  const insert = db.prepare('INSERT INTO rows (body) VALUES (randomblob(1048576))')
  db.exec('BEGIN')
  for (let i = 0; i < keptMiB + freedMiB; i++) {
    insert.run()
  }
  db.exec('COMMIT')
  db.prepare('DELETE FROM rows WHERE id > ?').run(keptMiB)
  db.close()
  return file
}

function autoVacuum(file: string): number {
  const db = new DatabaseSync(file)
  try {
    return Number(db.prepare('PRAGMA auto_vacuum').get()!.auto_vacuum)
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('compactOrchestrationDbOnce', () => {
  it('shrinks a mostly free legacy file once and switches it to incremental', async () => {
    const file = legacyDatabase(8, 40)
    const before = statSync(file).size

    const result = await compactOrchestrationDbOnce(file)

    expect(result.kind).toBe('compacted')
    expect(statSync(file).size).toBeLessThan(before / 4)
    expect(autoVacuum(file)).toBe(2)
    expect(await compactOrchestrationDbOnce(file)).toEqual({ kind: 'not-needed' })
  })

  it('leaves a file another connection is writing for the next launch', async () => {
    const file = legacyDatabase(8, 40)
    const holder = new DatabaseSync(file)
    holder.exec('BEGIN IMMEDIATE')
    try {
      expect(await compactOrchestrationDbOnce(file)).toEqual({ kind: 'busy' })
    } finally {
      holder.exec('ROLLBACK')
      holder.close()
    }
    expect(autoVacuum(file)).toBe(0)
  })

  it('skips a file with under 32 MiB free', async () => {
    const file = legacyDatabase(1, 20)

    expect(await compactOrchestrationDbOnce(file)).toEqual({ kind: 'not-needed' })
    expect(autoVacuum(file)).toBe(0)
  })
})
