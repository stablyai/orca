import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  checkpointOffMainThread,
  MAIN_CHECKPOINT_BACKSTOP_PAGES
} from './orchestration-checkpoint-thread'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const undo of cleanup.splice(0).toReversed()) {
    undo()
  }
})

function fileDb(): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-orchestration-checkpoint-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  db.db.exec('CREATE TABLE checkpoint_probe (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  cleanup.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return db
}

function frames(db: OrchestrationDb): { log: number; checkpointed: number } {
  const row = db.db.prepare('PRAGMA wal_checkpoint(NOOP)').get()
  return { log: Number(row?.log), checkpointed: Number(row?.checkpointed) }
}

describe('the orchestration checkpoint thread', () => {
  it('leaves a small WAL to batch, then checkpoints a full batch off main', async () => {
    const db = fileDb()
    cleanup.push(checkpointOffMainThread(db))
    const write = db.db.prepare('INSERT OR REPLACE INTO checkpoint_probe (id, body) VALUES (?, ?)')
    for (let i = 0; i < 20; i++) {
      write.run(i, 'x'.repeat(100))
    }
    // Several busy ticks pass; checkpointing a few frames would make main restart the WAL on its next commit.
    // ast-grep-ignore: test-no-real-time-wait -- asserts the worker leaves the WAL alone across real ticks
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(frames(db).checkpointed).toBe(0)

    for (let i = 0; i < 1200; i++) {
      write.run(i, 'y'.repeat(3000))
    }
    // Pending frames, not `checkpointed`: a WAL restart after the last batch zeroes both counters.
    await vi.waitFor(
      () => {
        const { log, checkpointed } = frames(db)
        expect(log - checkpointed).toBeLessThan(1000)
      },
      { timeout: 5000 }
    )
    // Main kept its backstop, so the worker, not main's own autocheckpoint, drained it.
    expect(db.db.prepare('PRAGMA wal_autocheckpoint').get()).toEqual({
      wal_autocheckpoint: MAIN_CHECKPOINT_BACKSTOP_PAGES
    })
  })
})
