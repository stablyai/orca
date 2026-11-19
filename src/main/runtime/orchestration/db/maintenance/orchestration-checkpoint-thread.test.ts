import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { checkpointOffMainThread } from './orchestration-checkpoint-thread'

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
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(frames(db).checkpointed).toBe(0)

    for (let i = 0; i < 1200; i++) {
      write.run(i, 'y'.repeat(3000))
    }
    const written = frames(db).log
    expect(written).toBeGreaterThanOrEqual(1000)
    await vi.waitFor(() => expect(frames(db).checkpointed).toBeGreaterThan(0), { timeout: 5000 })
  })
})
