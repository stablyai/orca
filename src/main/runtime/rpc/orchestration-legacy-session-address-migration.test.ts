import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestrationDb } from '../orchestration/db'
import { migrateV43 } from '../orchestration/db/schema/migrate-v43'
import {
  ADDRESS_X,
  ADDRESS_Y,
  createSessionCallerHarness,
  orchestrationRequest,
  resultOf,
  SESSION_X,
  SESSION_Y,
  WORKER_HANDLE,
  type SessionCallerHarness
} from './orchestration-session-caller-test-fixture'

const hostRef = vi.hoisted((): { current: unknown } => ({ current: null }))
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

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
  let seeded: { toX: string; fromX: string }

  beforeEach(() => {
    h = createSessionCallerHarness(hostRef)
    hostRef.current = {
      deps: {
        store: {
          getRecord: (sessionId: string) => h.records.get(sessionId) ?? null,
          listRecords: () => [...h.records.values()],
          getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [SESSION_X, SESSION_Y] })
        }
      }
    }
    seeded = seedEarlierBuildRows(h.db)
    h.db.migrate()
  })

  afterEach(() => {
    h.close()
    vi.restoreAllMocks()
  })

  it('gives the chat the mail sent to it before the upgrade, through its own check', async () => {
    const checked = resultOf(
      await h.dispatch(orchestrationRequest('orchestration.check', {}, { sessionId: SESSION_X }))
    )
    expect(checked.messages).toEqual([
      expect.objectContaining({
        id: seeded.toX,
        to_handle: ADDRESS_X,
        subject: LEGACY_X,
        body: LEGACY_X
      })
    ])
  })

  it('still routes mail to a chat into the Run it was remembered for under the old spelling', async () => {
    const sent = await h.dispatch(
      orchestrationRequest('orchestration.send', {
        from: WORKER_HANDLE,
        to: ADDRESS_Y,
        subject: 's'
      })
    )
    expect(sent).toMatchObject({ ok: true, result: { message: { to_handle: 'run:run_earlier' } } })
  })

  it('refuses the old spelling as an unknown terminal, even for the Run once remembered under it', async () => {
    const stored = h.db.getInbox(100).length
    for (const legacy of [LEGACY_X, LEGACY_Y]) {
      const sent = await h.dispatch(
        orchestrationRequest('orchestration.send', {
          from: WORKER_HANDLE,
          to: legacy,
          subject: 's'
        })
      )
      expect(sent).toMatchObject({
        ok: false,
        error: {
          code: 'terminal_not_found',
          message: `Terminal ${legacy} has no live pane or durable Run/Dispatch mailbox.`
        }
      })
    }
    expect(h.db.getInbox(100)).toHaveLength(stored)
  })

  it('files a reply to mail the chat sent before the upgrade at its current address', async () => {
    expect(h.db.getMessageById(seeded.fromX)?.from_handle).toBe(ADDRESS_X)
    const replied = await h.dispatch(
      orchestrationRequest('orchestration.reply', {
        id: seeded.fromX,
        body: 'a',
        from: WORKER_HANDLE
      })
    )
    expect(replied).toMatchObject({ ok: true, result: { message: { to_handle: ADDRESS_X } } })
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

  it('changes nothing when it runs again', () => {
    const before = snapshot(h.db)
    migrateV43.call(h.db, 42)
    expect(snapshot(h.db)).toEqual(before)
  })
})
