import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import '../runtime/orchestration/db/contract-constants'
import '../runtime/orchestration/db/dispatch-row-writer'
import { createRootDispatch } from '../runtime/orchestration/db/root-dispatch-test-fixture'
import { AGENT_PROMPT_STALLED_ERROR } from '../runtime/terminal/input/agent-prompt-submission-verification'
import { botItemAskWhileWorker } from './bot-item-ask-while-worker'

const opened: { db: OrchestrationDb; dir: string }[] = []

afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

function openDb(): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-ask-while-worker-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  opened.push({ db, dir })
  return db
}

/** A worker's attempt as orchestration recorded it, with its worker row when given a state. */
function attempt(
  db: OrchestrationDb,
  fields: {
    task?: string
    status: string
    lastFailure?: string
    worker?: string
    retryOf?: string
    followUpOf?: string
  }
): { id: string; task: string } {
  const task = fields.task ?? db.createTask({ runId: 'run_legacy_local', spec: 'work' }).id
  // A retry starts once its Task is ready again.
  db.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task)
  const { id } = createRootDispatch(db, task, `term_${Math.random()}`)
  db.db
    .prepare(
      `UPDATE dispatch_contexts SET status = ?, last_failure = ?, retry_of_dispatch_id = ?,
         follow_up_of_dispatch_id = ? WHERE id = ?`
    )
    .run(
      fields.status,
      fields.lastFailure ?? null,
      fields.retryOf ?? null,
      fields.followUpOf ?? null,
      id
    )
  if (fields.worker) {
    db.db
      .prepare('INSERT INTO worker_dispatches (dispatch_id, state) VALUES (?, ?)')
      .run(id, fields.worker)
  }
  return { id, task }
}

describe('botItemAskWhileWorker', () => {
  it('settles only on a recorded end: reported, failed for good, or stopped', () => {
    const db = openDb()
    expect(botItemAskWhileWorker(db, attempt(db, { status: 'dispatched' }).id)).toBe('running')
    expect(botItemAskWhileWorker(db, attempt(db, { status: 'completed' }).id)).toBe('completed')
    const stopped = attempt(db, { status: 'failed', lastFailure: 'stopped' })
    expect(botItemAskWhileWorker(db, stopped.id)).toBe('stopped')
    const failed = attempt(db, { status: 'failed', lastFailure: 'boom', worker: 'failed' })
    expect(botItemAskWhileWorker(db, failed.id)).toBe('failed')
  })

  it('reads unknown while a failed attempt may still report or recover, or is not on this computer', () => {
    const db = openDb()
    const stalled = attempt(db, { status: 'failed', lastFailure: AGENT_PROMPT_STALLED_ERROR })
    db.db.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(stalled.task)
    expect(botItemAskWhileWorker(db, stalled.id)).toBe('unknown')
    const recovering = attempt(db, {
      status: 'failed',
      lastFailure: 'boom',
      worker: 'stop_unknown'
    })
    expect(botItemAskWhileWorker(db, recovering.id)).toBe('unknown')
    expect(botItemAskWhileWorker(db, 'ctx_elsewhere')).toBe('unknown')
    expect(botItemAskWhileWorker(null, stalled.id)).toBe('unknown')
  })

  it('follows a retry and a follow-up to the attempt that speaks for the worker now', () => {
    const db = openDb()
    const first = attempt(db, { status: 'failed', lastFailure: 'boom', worker: 'failed' })
    const retry = attempt(db, { task: first.task, status: 'completed', retryOf: first.id })
    const followUp = attempt(db, { status: 'dispatched', followUpOf: retry.id })
    expect(botItemAskWhileWorker(db, first.id)).toBe('running')
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(followUp.id)
    expect(botItemAskWhileWorker(db, first.id)).toBe('completed')
  })
})
