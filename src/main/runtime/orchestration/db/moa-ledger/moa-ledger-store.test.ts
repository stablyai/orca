import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

function createDbWithRun(): { db: OrchestrationDb; runId: string } {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'MoA ledger test run',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_coord:leaf_coord'
  })
  return { db, runId: run.id }
}

describe('moa-ledger-store', () => {
  it('creates the deliberation implicitly and records entries append-only', () => {
    const { db, runId } = createDbWithRun()
    const result = db.logMoaEntries({
      runId,
      deliberationId: 'ledger-storage',
      seatCount: 3,
      entries: [
        { kind: 'proposal', seat: 'seat-A', rationale: 'tables as store' },
        { kind: 'proposal', seat: 'seat-B', rationale: 'messages as WAL' }
      ]
    })
    expect(result.inserted).toBe(2)
    expect(result.duplicates).toBe(0)
    expect(result.deliberation.seat_count).toBe(3)

    const entries = db.listMoaEntries({ deliberationId: 'ledger-storage' })
    expect(entries).toHaveLength(2)
    expect(entries.every((entry) => entry.id.startsWith('moae_'))).toBe(true)
  })

  it('ignores duplicate entries via content-addressed ids', () => {
    const { db, runId } = createDbWithRun()
    const entry = { kind: 'verdict', round: 2, seat: 'seat-A', verdict: 'support' as const }
    const first = db.logMoaEntries({ runId, deliberationId: 'd1', entries: [entry] })
    const second = db.logMoaEntries({ runId, deliberationId: 'd1', entries: [entry] })
    expect(first.inserted).toBe(1)
    expect(second.inserted).toBe(0)
    expect(second.duplicates).toBe(1)
    expect(db.listMoaEntries({ deliberationId: 'd1' })).toHaveLength(1)
  })

  it('rejects invalid kinds, verdicts, payloads, and rounds in TypeScript, not SQL', () => {
    const { db, runId } = createDbWithRun()
    const base = { runId, deliberationId: 'd1' }
    expect(() => db.logMoaEntries({ ...base, entries: [{ kind: 'vote' }] })).toThrow(
      /Invalid MoA entry kind/
    )
    expect(() =>
      db.logMoaEntries({ ...base, entries: [{ kind: 'verdict', verdict: 'approve' }] })
    ).toThrow(/Invalid MoA verdict/)
    expect(() =>
      db.logMoaEntries({ ...base, entries: [{ kind: 'note', payload: 'not json' }] })
    ).toThrow(/payload must be valid JSON/)
    expect(() => db.logMoaEntries({ ...base, entries: [{ kind: 'note', round: 0 }] })).toThrow(
      /positive integer/
    )
    expect(db.listMoaEntries({ deliberationId: 'd1' })).toHaveLength(0)
  })

  it('orders entries by (round, authored_at, id), not arrival order', () => {
    const { db, runId } = createDbWithRun()
    db.logMoaEntries({
      runId,
      deliberationId: 'd1',
      entries: [
        { kind: 'verdict', round: 2, seat: 'seat-B', authoredAt: '2026-08-25T10:05:00Z' },
        { kind: 'verdict', round: 2, seat: 'seat-A', authoredAt: '2026-08-25T10:01:00Z' },
        { kind: 'proposal', round: 1, seat: 'seat-C', authoredAt: '2026-08-25T09:00:00Z' }
      ]
    })
    const entries = db.listMoaEntries({ deliberationId: 'd1' })
    expect(entries.map((entry) => [entry.round, entry.seat_id])).toEqual([
      [1, 'seat-C'],
      [2, 'seat-A'],
      [2, 'seat-B']
    ])
  })

  it('materializes payload.moa from status messages with message provenance', () => {
    const { db, runId } = createDbWithRun()
    const message = db.insertMessage({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'proposal ready',
      runId,
      payload: JSON.stringify({
        moa: {
          deliberation: 'ledger-storage',
          seatCount: 3,
          entries: [{ kind: 'proposal', seat: 'seat-A', rationale: 'tables as store' }]
        }
      })
    })
    const entries = db.listMoaEntries({ deliberationId: 'ledger-storage' })
    expect(entries).toHaveLength(1)
    expect(entries[0].message_id).toBe(message.id)
    expect(db.getMoaDeliberation('ledger-storage')?.seat_count).toBe(3)
  })

  it('never materializes from non-status types and never fails message delivery on bad payloads', () => {
    const { db, runId } = createDbWithRun()
    const moaPayload = JSON.stringify({
      moa: { deliberation: 'd1', entries: [{ kind: 'note' }] }
    })
    db.insertMessage({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'done',
      type: 'heartbeat',
      runId,
      payload: moaPayload
    })
    expect(db.listMoaEntries({ deliberationId: 'd1' })).toHaveLength(0)

    for (const payload of ['not json', JSON.stringify({ moa: { entries: 'nope' } })]) {
      const inserted = db.insertMessage({
        from: 'term_seat',
        to: `run:${runId}`,
        subject: 'malformed moa',
        runId,
        payload
      })
      expect(inserted.id).toBeTruthy()
    }
    // Why: one invalid entry rejects the whole batch quietly — partial batches would desync ledgers across hosts.
    db.insertMessage({
      from: 'term_seat',
      to: `run:${runId}`,
      subject: 'half valid',
      runId,
      payload: JSON.stringify({
        moa: { deliberation: 'd1', entries: [{ kind: 'note' }, { kind: 'vote' }] }
      })
    })
    expect(db.listMoaEntries({ deliberationId: 'd1' })).toHaveLength(0)
  })

  it('is cleared by resetTasks and resetAll but survives resetMessages', () => {
    const { db, runId } = createDbWithRun()
    const log = () =>
      db.logMoaEntries({
        runId,
        deliberationId: 'd1',
        entries: [{ kind: 'note', rationale: 'kept?' }]
      })

    log()
    db.resetMessages()
    expect(db.listMoaEntries({ deliberationId: 'd1' })).toHaveLength(1)

    db.resetTasks()
    expect(db.listMoaEntries({ deliberationId: 'd1' })).toHaveLength(0)
    expect(db.getMoaDeliberation('d1')).toBeUndefined()

    log()
    db.resetAll()
    expect(db.getMoaDeliberation('d1')).toBeUndefined()
  })

  it('refuses to reuse a deliberation id from another run', () => {
    const { db, runId } = createDbWithRun()
    db.logMoaEntries({ runId, deliberationId: 'd1', entries: [{ kind: 'note' }] })
    const other = db.createRun({
      objective: 'second run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    expect(() =>
      db.logMoaEntries({ runId: other.id, deliberationId: 'd1', entries: [{ kind: 'note' }] })
    ).toThrow(/belongs to another Run/)
  })
})
