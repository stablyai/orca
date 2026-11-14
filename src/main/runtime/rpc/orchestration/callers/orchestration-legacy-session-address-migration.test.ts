import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../../../orchestration/db/orchestration-db'
import {
  ADDRESS_X,
  ADDRESS_Y,
  createSessionCallerHarness,
  SESSION_X,
  SESSION_Y,
  WORKER_HANDLE,
  type SessionCallerHarness
} from './session.test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock(
  '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry',
  () => ({
    getStructuredAgentSessionHost: () => hostRef.current
  })
)

const LEGACY_X = `session:${SESSION_X}`
const LEGACY_Y = `session:${SESSION_Y}`
// Remembered under both spellings; a session of its own, so routing to Y stays unambiguous.
const BOTH_SESSION = '5c5c5c5c-6d6d-4e7e-8f8f-909090909090'

/** What an earlier build, which spelled a session's address `session:<id>`, left in a v42 database. */
function seedEarlierBuildRows(db: OrchestrationDb): { toX: string; fromX: string } {
  // Subject and body spell the old address too: text, not an address, so it must survive as written.
  const toX = db.insertMessage({
    from: WORKER_HANDLE,
    to: ADDRESS_X,
    subject: LEGACY_X,
    body: LEGACY_X
  })
  const fromX = db.insertMessage({ from: ADDRESS_X, to: WORKER_HANDLE, subject: 'q', body: 'b' })
  db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(LEGACY_X, toX.id)
  db.db.prepare('UPDATE messages SET from_handle = ? WHERE id = ?').run(LEGACY_X, fromX.id)
  db.db
    .prepare(
      `INSERT INTO runs (id, objective, consumer_generation, legacy) VALUES
         ('run_earlier', 'coordinated by Y', 1, 0), ('run_both', 'remembered twice', 1, 0)`
    )
    .run()
  const remember = db.db.prepare(
    'INSERT INTO run_coordinator_handles (run_id, terminal_handle) VALUES (?, ?)'
  )
  remember.run('run_earlier', LEGACY_Y)
  remember.run('run_both', `session:${BOTH_SESSION}`)
  remember.run('run_both', `orca_session_id:${BOTH_SESSION}`)
  const pointer = db.db.prepare(
    `INSERT INTO structured_pointer_operations
       (mailbox_handle, session_id, operation_id, batch_fingerprint, minted_at_ms)
     VALUES (?, ?, ?, 'batch', 1)`
  )
  pointer.run(LEGACY_X, SESSION_X, 'op_legacy_x')
  pointer.run(LEGACY_Y, SESSION_Y, 'op_legacy_y')
  pointer.run(ADDRESS_Y, SESSION_Y, 'op_current_y')
  db.createCoordinatorRun({ spec: 'spec', coordinatorHandle: LEGACY_X })
  db.db.pragma('user_version = 42')
  return { toX: toX.id, fromX: fromX.id }
}

function snapshot(db: OrchestrationDb): unknown[] {
  return [
    'SELECT id, from_handle, to_handle, subject, body FROM messages ORDER BY id',
    'SELECT run_id, terminal_handle FROM run_coordinator_handles ORDER BY run_id, terminal_handle',
    'SELECT mailbox_handle, operation_id FROM structured_pointer_operations ORDER BY mailbox_handle',
    'SELECT coordinator_handle FROM coordinator_runs'
  ].map((sql) => db.db.prepare(sql).all())
}

describe('a database an earlier build wrote session:<id> addresses into', () => {
  let h: SessionCallerHarness

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef, () => ({
      present: true,
      sessionIds: [SESSION_X, SESSION_Y]
    }))
    seedEarlierBuildRows(h.db)
    h.db.migrate()
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('leaves no address in the old spelling, keeping the current row where both were keyed', () => {
    const [messages, remembered, pointers, coordinatorRuns] = snapshot(h.db)
    expect(JSON.stringify([messages, remembered, pointers, coordinatorRuns])).not.toMatch(
      /"(from_handle|to_handle|terminal_handle|mailbox_handle|coordinator_handle)":"session:/
    )
    expect(remembered).toEqual([
      { run_id: 'run_both', terminal_handle: `orca_session_id:${BOTH_SESSION}` },
      { run_id: 'run_earlier', terminal_handle: ADDRESS_Y }
    ])
    expect(pointers).toEqual([
      { mailbox_handle: ADDRESS_X, operation_id: 'op_legacy_x' },
      { mailbox_handle: ADDRESS_Y, operation_id: 'op_current_y' }
    ])
    expect(coordinatorRuns).toEqual([{ coordinator_handle: ADDRESS_X }])
  })
})
