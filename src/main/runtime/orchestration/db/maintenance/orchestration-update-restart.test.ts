import { mkdtemp, rm, statfs } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { OrchestrationDbMaintenance } from './orchestration-db-maintenance'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, statfs: vi.fn(actual.statfs) }
})

const realFs = await vi.importActual<typeof fs>('node:fs/promises')

let directory: string
let db: OrchestrationDb
let closed = false

afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.statfs).mockImplementation(realFs.statfs)
  if (!closed) {
    db?.close()
  }
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function legacyFile(bytes = 201_000_000) {
  directory = await mkdtemp(join(tmpdir(), 'orchestration-update-'))
  const filename = join(directory, 'orchestration.db')
  db = new OrchestrationDb(filename)
  closed = false
  db.db.exec('PRAGMA auto_vacuum = NONE; VACUUM; CREATE TABLE padding (body BLOB)')
  db.db.prepare('INSERT INTO padding VALUES (zeroblob(?))').run(bytes)
  db.db.exec("DELETE FROM padding; INSERT INTO runs (id, objective) VALUES ('saved', 'keep me')")
  return { filename, maintenance: new OrchestrationDbMaintenance(db, filename, () => false) }
}

function closeWriters() {
  db.close()
  closed = true
}

it('rewrites a legacy file with over 200 MB unused and room on disk, preserving the last write', async () => {
  const { filename, maintenance } = await legacyFile()
  const disk = await statfs(directory)
  vi.mocked(fs.statfs).mockImplementation(async () => {
    db.db.prepare("UPDATE runs SET objective = 'last write' WHERE id = 'saved'").run()
    return { ...disk, bavail: 1_000_000, bsize: 4096 }
  })
  await maintenance.reclaimOnUpdateRestart(closeWriters)
  const saved = new Database(filename)
  try {
    expect(saved.pragma('auto_vacuum', { simple: true })).toBe(2)
    expect(saved.pragma('freelist_count', { simple: true })).toBe(0)
    expect(saved.prepare("SELECT objective FROM runs WHERE id = 'saved'").get()?.objective).toBe(
      'last write'
    )
    expect(saved.pragma('integrity_check', { simple: true })).toBe('ok')
  } finally {
    saved.close()
  }
})

it('does not retry an admitted rewrite that failed, even at the next update', async () => {
  const { filename, maintenance } = await legacyFile()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await maintenance.reclaimOnUpdateRestart(() => {
    throw new Error('cannot close writer')
  })
  db.close()
  db = new OrchestrationDb(filename)
  const nextUpdate = new OrchestrationDbMaintenance(db, filename, () => false)
  await nextUpdate.reclaimOnUpdateRestart(closeWriters)
  expect(db.db.pragma('auto_vacuum', { simple: true })).toBe(0)
  expect(
    db.db.prepare('SELECT reclaim_failed FROM orchestration_maintenance').get()?.reclaim_failed
  ).toBe(1)
  expect(db.db.prepare("SELECT objective FROM runs WHERE id = 'saved'").get()?.objective).toBe(
    'keep me'
  )
})

it('defers a legacy rewrite when disk is short without recording an attempted rewrite', async () => {
  const { maintenance } = await legacyFile()
  const disk = await statfs(directory)
  vi.mocked(fs.statfs).mockResolvedValue({ ...disk, bavail: 0 })
  await maintenance.reclaimOnUpdateRestart(closeWriters)
  expect(db.db.pragma('auto_vacuum', { simple: true })).toBe(0)
  expect(
    db.db.prepare('SELECT reclaim_failed FROM orchestration_maintenance').get()
  ).toBeUndefined()
})

it('leaves small legacy files and already incremental files alone', async () => {
  const { maintenance } = await legacyFile(1_000_000)
  await maintenance.reclaimOnUpdateRestart(closeWriters)
  expect(db.db.pragma('auto_vacuum', { simple: true })).toBe(0)
  db.db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM')
  db.db.prepare('INSERT INTO padding VALUES (zeroblob(?))').run(201_000_000)
  db.db.exec('DELETE FROM padding')
  await maintenance.reclaimOnUpdateRestart(closeWriters)
  expect(db.db.pragma('freelist_count', { simple: true })).toBeGreaterThan(48_828)
  expect(
    db.db.prepare('SELECT reclaim_failed FROM orchestration_maintenance').get()
  ).toBeUndefined()
})
