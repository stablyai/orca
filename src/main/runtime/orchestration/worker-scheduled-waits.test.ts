import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch, reattachDispatchConsumer } from './db/root-dispatch-test-fixture'
import { reportWorkerTurnStop } from './worker-turn-stop-report'
import { recordWorkerScheduledWait, clearWorkerScheduledWait } from './db/worker-scheduled-waits'
import { reportExpiredWorkerWaits } from './worker-scheduled-wait-scheduler'

const NOW = Date.parse('2026-11-03T12:00:00Z')
const temporaryDirectories: string[] = []
const databases: OrchestrationDb[] = []

function setup(path = ':memory:') {
  const db = new OrchestrationDb(path)
  databases.push(db)
  const run = db.createRun({
    objective: 'scheduled worker',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: null
  })
  const task = db.createTask({ spec: 'watch until tomorrow', runId: run.id })
  const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab:leaf')
  const deps = { getDb: () => db, isWaitingForMail: () => false, notify: vi.fn() }
  const target = { kind: 'local' as const, dispatch }
  const stop = {
    from: 'term_worker',
    stopKey: 'turn:one',
    reason: 'finished' as const,
    lastOutput: 'Waiting for the next scheduled wake'
  }
  const wait = () =>
    recordWorkerScheduledWait(db, {
      dispatchId: dispatch.id,
      until: new Date(NOW + 60_000).toISOString(),
      reason: 'Next scheduled check',
      messageId: 'msg_wait',
      from: 'term_worker'
    })
  const mail = () => db.getUnreadRunMailbox(run.id, 100, ['escalation'])
  return { db, run, task, dispatch, target, stop, deps, wait, mail }
}

afterEach(() => {
  vi.useRealTimers()
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('scheduled worker waits', () => {
  it('suppresses only the declaring Dispatch clean stop before its deadline', () => {
    vi.useFakeTimers({ now: NOW })
    const h = setup()
    h.wait()
    reportWorkerTurnStop(h.db, h.target, h.stop, h.deps)
    expect(h.mail()).toEqual([])
    expect(h.deps.notify).not.toHaveBeenCalled()
    const task = h.db.createTask({ spec: 'another worker', runId: h.run.id })
    const dispatch = createRootDispatch(h.db, task.id, 'term_other')
    reportWorkerTurnStop(
      h.db,
      { kind: 'local', dispatch },
      { ...h.stop, from: 'term_other' },
      h.deps
    )
    expect(h.mail()).toHaveLength(1)
  })

  it.each(['errored', 'needs-input', 'exited'] as const)(
    'still escalates %s during a wait',
    (reason) => {
      vi.useFakeTimers({ now: NOW })
      const h = setup()
      h.wait()
      reportWorkerTurnStop(
        h.db,
        h.target,
        { ...h.stop, reason },
        { ...h.deps, isWaitingForMail: () => true }
      )
      expect(h.mail()).toHaveLength(1)
    }
  )

  it('retains the existing clean-stop alert when no explicit wait was declared', () => {
    const h = setup()
    reportWorkerTurnStop(h.db, h.target, h.stop, h.deps)
    expect(h.mail()[0].subject).toBe('Worker stopped without reporting')
  })

  it('escalates a missed deadline once without requiring another stop, including after reopen', () => {
    vi.useFakeTimers({ now: NOW })
    const dir = mkdtempSync(join(tmpdir(), 'orca-scheduled-wait-'))
    temporaryDirectories.push(dir)
    const h = setup(join(dir, 'orchestration.db'))
    h.wait()
    reportWorkerTurnStop(h.db, h.target, h.stop, h.deps)
    const db = new OrchestrationDb(join(dir, 'orchestration.db'))
    databases.push(db)
    vi.setSystemTime(NOW + 60_001)
    reportExpiredWorkerWaits(db, h.deps)
    reportExpiredWorkerWaits(db, h.deps)
    reportWorkerTurnStop(db, h.target, h.stop, h.deps)
    expect(h.mail()).toHaveLength(1)
    expect(h.mail()[0].body).toContain('Next scheduled check')
    expect(h.mail()[0].body).toContain('expired')
  })

  it('reports expiry only once when a clean stop beats the deadline timer or is observed again', () => {
    vi.useFakeTimers({ now: NOW })
    const h = setup()
    h.wait()
    vi.setSystemTime(NOW + 60_001)
    reportWorkerTurnStop(h.db, h.target, h.stop, h.deps)
    expect(h.mail()).toEqual([])
    reportExpiredWorkerWaits(h.db, h.deps)
    reportWorkerTurnStop(h.db, h.target, { ...h.stop, stopKey: 'replayed:idle' }, h.deps)
    reportExpiredWorkerWaits(h.db, h.deps)
    expect(h.mail()).toHaveLength(1)
    expect(h.mail()[0].subject).toBe('Worker scheduled wait expired')
  })

  it('clears the wait when its queued mail is actually consumed, not merely inserted', () => {
    vi.useFakeTimers({ now: NOW })
    const h = setup()
    h.wait()
    const message = h.db.insertMessage({
      from: 'term_coordinator',
      to: `dispatch:${h.dispatch.id}`,
      subject: 'Check now',
      runId: h.run.id
    })
    reportWorkerTurnStop(h.db, h.target, h.stop, h.deps)
    expect(h.mail()).toEqual([])
    h.db.markAsReadAndDelivered([message.id])
    reportWorkerTurnStop(h.db, h.target, { ...h.stop, stopKey: 'turn:two' }, h.deps)
    expect(h.mail()).toHaveLength(1)
  })

  it('does not transfer a scheduled wait to a replacement worker incarnation', () => {
    vi.useFakeTimers({ now: NOW })
    const h = setup()
    h.wait()
    reattachDispatchConsumer(h.db, {
      dispatchId: h.dispatch.id,
      paneKey: 'tab:leaf',
      processIncarnation: 'replacement'
    })
    reportWorkerTurnStop(h.db, h.target, h.stop, h.deps)
    expect(h.mail()).toHaveLength(1)
  })

  it('clears a restored wait only when the working turn started after it was recorded', () => {
    const h = setup()
    h.db.insertMessage({
      id: 'msg_wait',
      from: 'term_worker',
      to: `run:${h.run.id}`,
      subject: 'status',
      type: 'status',
      runId: h.run.id
    })
    h.db.db
      .prepare('UPDATE messages SET created_at = ? WHERE id = ?')
      .run('2026-11-03 11:00:00', 'msg_wait')
    h.wait()

    h.db.clearWorkerScheduledWaitForPaneIfTurnStartedAfter(
      'tab:leaf',
      Date.parse('2026-11-03T11:00:00.500Z')
    )
    expect(
      h.db.db
        .prepare('SELECT 1 FROM worker_scheduled_waits WHERE dispatch_id = ?')
        .get(h.dispatch.id)
    ).toBeDefined()

    h.db.clearWorkerScheduledWaitForPaneIfTurnStartedAfter(
      'tab:leaf',
      Date.parse('2026-11-03T12:00:00Z')
    )
    expect(
      h.db.db
        .prepare('SELECT 1 FROM worker_scheduled_waits WHERE dispatch_id = ?')
        .get(h.dispatch.id)
    ).toBeUndefined()
  })

  it('reads a remote wait recording time from its relay item', () => {
    const h = setup()
    recordWorkerScheduledWait(h.db, {
      dispatchId: h.dispatch.id,
      until: new Date(NOW + 60_000).toISOString(),
      reason: 'Next remote check',
      messageId: 'relay_wait',
      from: 'term_worker'
    })
    h.db.db
      .prepare(
        `INSERT INTO federation_relay_items (
           dispatch_id, direction, sequence, message_id, kind, payload, byte_count, created_at
         ) VALUES (?, 'to_home', 1, 'relay_wait', 'status', '{}', 2, '2026-11-03 11:00:00')`
      )
      .run(h.dispatch.id)

    h.db.clearWorkerScheduledWaitForPaneIfTurnStartedAfter(
      'tab:leaf',
      Date.parse('2026-11-03T11:00:00.500Z')
    )
    expect(
      h.db.db
        .prepare('SELECT 1 FROM worker_scheduled_waits WHERE dispatch_id = ?')
        .get(h.dispatch.id)
    ).toBeDefined()

    h.db.clearWorkerScheduledWaitForPaneIfTurnStartedAfter(
      'tab:leaf',
      Date.parse('2026-11-03T12:00:00Z')
    )
    expect(
      h.db.db
        .prepare('SELECT 1 FROM worker_scheduled_waits WHERE dispatch_id = ?')
        .get(h.dispatch.id)
    ).toBeUndefined()
  })

  it('does not report an expired wait after progress or settlement', () => {
    vi.useFakeTimers({ now: NOW })
    const h = setup()
    h.wait()
    clearWorkerScheduledWait(h.db, h.dispatch.id)
    vi.setSystemTime(NOW + 60_001)
    reportExpiredWorkerWaits(h.db, h.deps)
    expect(h.mail()).toEqual([])
    vi.setSystemTime(NOW)
    h.wait()
    h.db.completeDispatch(h.dispatch.id)
    vi.setSystemTime(NOW + 60_001)
    reportExpiredWorkerWaits(h.db, h.deps)
    expect(h.mail()).toEqual([])
  })
})
