import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import {
  findNewestCodexStateDbPath,
  isCodexStateDbBackfillPending,
  readCodexStateDbBackfillStatus
} from './codex-state-db'

const temporaryHomes: string[] = []

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-codex-state-db-'))
  temporaryHomes.push(home)
  return home
}

function createBackfillDb(home: string, version: number, status: string): string {
  const path = join(home, `state_${version}.sqlite`)
  const db = new SyncDatabase(path)
  db.exec(
    'CREATE TABLE backfill_state (id INTEGER PRIMARY KEY, status TEXT NOT NULL); ' +
      `INSERT INTO backfill_state (id, status) VALUES (1, '${status}')`
  )
  db.close()
  return path
}

afterEach(async () => {
  await Promise.all(
    temporaryHomes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
  )
})

describe('Codex state DB backfill status', () => {
  it('reads the newest schema DB without mutating an incomplete row', async () => {
    const home = await createHome()
    createBackfillDb(home, 4, 'complete')
    const newest = createBackfillDb(home, 5, 'running')

    expect(findNewestCodexStateDbPath(home)).toBe(newest)
    expect(readCodexStateDbBackfillStatus(home)).toEqual({
      kind: 'incomplete',
      stateDbPath: newest,
      status: 'running'
    })

    const db = new SyncDatabase(newest, { readonly: true, fileMustExist: true })
    expect(db.prepare('SELECT status FROM backfill_state WHERE id = 1').get()).toEqual({
      status: 'running'
    })
    db.close()
  })

  it('treats a large unindexed rollout history as pending', async () => {
    const home = await createHome()
    const sessions = join(home, 'sessions', '2026', '08', '04')
    await mkdir(sessions, { recursive: true })
    await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        writeFile(join(sessions, `rollout-${index}.jsonl`), '{}\n')
      )
    )

    expect(isCodexStateDbBackfillPending(home)).toBe(true)
  })

  it('does not call a complete backfill pending', async () => {
    const home = await createHome()
    createBackfillDb(home, 5, 'complete')

    expect(isCodexStateDbBackfillPending(home)).toBe(false)
  })
})
