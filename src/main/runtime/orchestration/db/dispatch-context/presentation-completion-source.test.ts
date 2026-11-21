import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { readPresentationDispatchCandidates } from './dispatch-presentation'
import { withPresentationCompletionSource } from './presentation-completion-source'
import { orchestrationProjectionFacts } from '../../crew/orchestration-projection-facts'

const now = Date.parse('2026-11-09T12:00:00Z')
afterEach(() => vi.restoreAllMocks())

function add(db: OrchestrationDb, id: string, completedAt: string) {
  db.db
    .prepare(
      "INSERT INTO dispatch_contexts(id,task_id,assignee_handle,status,completed_at) VALUES(?,'task',?,'completed',?)"
    )
    .run(id, id, completedAt)
}

it('reinstalls a completion source whose first initialization rolled back with its caller', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    db.db.exec('BEGIN; SAVEPOINT caller')
    add(db, 'rolled-back', '2026-11-09T12:00:00Z')
    expect(readPresentationDispatchCandidates(db, now).map((row) => row.id)).toEqual([
      'rolled-back'
    ])
    db.db.exec('ROLLBACK TO caller; RELEASE caller; ROLLBACK')
    add(db, 'committed', '2026-11-09 12:00:00')
    expect(readPresentationDispatchCandidates(db, now).map((row) => row.id)).toEqual(['committed'])
    db.db
      .prepare(
        "UPDATE dispatch_contexts SET id='renamed',completed_at='2020-01-01T00:00:00Z' WHERE id='committed'"
      )
      .run()
    expect(readPresentationDispatchCandidates(db, now)).toEqual([])
  } finally {
    db.close()
  }
})

it('rebuilds warm projection membership when the runtime timezone changes local completion meaning', () => {
  const prior = process.env.TZ
  const db = new OrchestrationDb(':memory:')
  vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    process.env.TZ = 'UTC'
    add(db, 'local-completion', '2026-11-09T04:00:00')
    expect([...orchestrationProjectionFacts(db, now)!.rows()]).toEqual([])
    process.env.TZ = 'America/Los_Angeles'
    expect([...orchestrationProjectionFacts(db, now)!.rows()].map((row) => row.id)).toEqual([
      'local-completion'
    ])
    process.env.TZ = 'UTC'
    expect([...orchestrationProjectionFacts(db, now)!.rows()]).toEqual([])
  } finally {
    if (prior === undefined) {
      delete process.env.TZ
    } else {
      process.env.TZ = prior
    }
    db.close()
  }
})

it('keeps normalization and candidate retrieval on one snapshot across an ordinary external commit', () => {
  const folder = mkdtempSync(join(tmpdir(), 'orca-completion-source-'))
  const path = join(folder, 'orchestration.sqlite')
  const db = new OrchestrationDb(path)
  db.db.pragma('journal_mode = WAL')
  const other = new OrchestrationDb(path)
  try {
    add(db, 'first', '2026-11-09T12:00:00Z')
    withPresentationCompletionSource(db.db, now, () => {
      add(other, 'external', '2026-11-09T12:00:00Z')
      expect(readPresentationDispatchCandidates(db, now).map((row) => row.id)).toEqual(['first'])
    })
    expect(readPresentationDispatchCandidates(db, now).map((row) => row.id)).toEqual([
      'first',
      'external'
    ])
    other.db
      .prepare("UPDATE dispatch_contexts SET completed_at='2020-01-01T00:00:00Z' WHERE id='first'")
      .run()
    expect(readPresentationDispatchCandidates(db, now).map((row) => row.id)).toEqual(['external'])
  } finally {
    other.close()
    db.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
