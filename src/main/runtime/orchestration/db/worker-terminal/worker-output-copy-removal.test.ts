import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  needsWorkerOutputCopyRemoval,
  runWorkerOutputCopyRemoval
} from './worker-output-copy-removal'

const SAVED_COPY = JSON.stringify({
  version: 2,
  agent: 'codex',
  processIncarnation: 'pty:1',
  messages: [{ id: 'm1', role: 'assistant', blocks: [{ type: 'text', text: 'x'.repeat(8_000) }] }],
  limited: false,
  warnings: []
})

function contents(db: OrchestrationDb): string[] {
  return db.db
    .prepare('SELECT content FROM worker_terminal_archives ORDER BY dispatch_id')
    .all()
    .map((row) => String(row.content))
}

describe('removing saved worker output copies', () => {
  let directory: string
  let path: string
  let db: OrchestrationDb

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-output-copy-removal-'))
    path = join(directory, 'orchestration.db')
    db = new OrchestrationDb(path)
    const insert = db.db.prepare(
      "INSERT INTO worker_terminal_archives (dispatch_id, resource_id, kind, content) VALUES (?, ?, 'transcript_pin', ?)"
    )
    for (let index = 0; index < 10; index += 1) {
      insert.run(`d_${index}`, `res_${index}`, SAVED_COPY)
    }
  })

  afterEach(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps only the fields a reader uses to find the original', async () => {
    expect(needsWorkerOutputCopyRemoval(db)).toBe(true)
    expect(await runWorkerOutputCopyRemoval(path, { gapMs: 0 }).finished).toBe(10)

    expect(contents(db)).toEqual(
      Array(10).fill('{"version":3,"agent":"codex","processIncarnation":"pty:1"}')
    )
    expect(needsWorkerOutputCopyRemoval(db)).toBe(false)
  })

  it('resumes from where a stopped run left off', async () => {
    const interrupted = runWorkerOutputCopyRemoval(path, { gapMs: 60_000 })
    await new Promise<void>((resolve) => interrupted.worker.once('message', () => resolve()))
    await interrupted.worker.terminate()
    expect(contents(db).filter((content) => content === SAVED_COPY)).toHaveLength(9)

    db.close()
    db = new OrchestrationDb(path)
    expect(await runWorkerOutputCopyRemoval(path, { gapMs: 0 }).finished).toBe(9)
    expect(contents(db)).not.toContain(SAVED_COPY)
  })

  it('caps the write-ahead log the database keeps after a checkpoint', () => {
    expect(db.db.prepare('PRAGMA journal_size_limit').get()).toEqual({
      journal_size_limit: 8_388_608
    })
  })
})
