import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentSessionConversationView } from '../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { formatOrcaSessionAddress } from '../../../../shared/agent-session/identity/orca-session-address'
import { testOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import type { OrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address'
import type { WorkerDockSnapshot } from '../../../../shared/orchestration/dock/worker-dock'
import type { FleetSessionObservation } from '../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import type * as SessionWorkerLiveness from '../workers/lifecycle/session-worker-liveness'

const hostRef: { current: unknown } = { current: null }
const hostListeners = new Set<() => void>()
vi.mock('../../../native-chat/agent-session-wire/host/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current,
  onStructuredAgentSessionHostChanged: (listener: () => void) => {
    hostListeners.add(listener)
    return () => hostListeners.delete(listener)
  }
}))
// The host's verdict on each structured worker's session, by its terminal handle.
const sessions = new Map<string, FleetSessionObservation>()
vi.mock('../workers/lifecycle/session-worker-liveness', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionWorkerLiveness>()
  return {
    ...actual,
    createSessionWorkerLivenessReader:
      () =>
      (worker: { agentTerminalHandle: string | null }): FleetSessionObservation | undefined =>
        worker.agentTerminalHandle ? sessions.get(worker.agentTerminalHandle) : undefined
  }
})

const { OrchestrationDb } = await import('../db/orchestration-db')
const { readWorkerDock } = await import('./worker-dock-read')
const { subscribeWorkerDock } = await import('./worker-dock-stream')
const { readWorkerDockActivity } = await import('./worker-dock-activity')
const {
  readWorkerDockElsewhereActivity,
  refreshWorkerDockElsewhereActivity,
  workerDockElsewhereActivitySource
} = await import('./worker-dock-elsewhere-activity')
const { backfillWorkerDockDelegations, workerDockDelegationsBackfilled } =
  await import('./worker-dock-delegations')
const { workerDockDelegationWake, watchWorkerDockBackfillHost } =
  await import('./worker-dock-delegation-wake')
const { sessionCrewChanges } = await import('../crew/crew-changes')

// A hands work to B by mail; B starts the workers. A's island shows them as an Other chats row.
const A = testOrcaSessionId('1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d')
const A_LIVE = testOrcaSessionId('2b3c4d5e-6f7a-4b8c-9dae-1f2a3b4c5d6e')
const B = testOrcaSessionId('3c4d5e6f-7a8b-4c9d-aebf-2a3b4c5d6e7f')
const C = testOrcaSessionId('4d5e6f7a-8b9c-4dae-bfca-3b4c5d6e7f8a')
const DAY = 24 * 60 * 60_000

function record(sessionId: string, name?: string, clearedInto?: string): AgentSessionRecord {
  const base = {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })),
    ...(name ? { conversationName: name } : {})
  }
  return clearedInto
    ? {
        ...base,
        conversationCommand: {
          command: 'clear',
          state: 'completed',
          replacementSessionId: clearedInto,
          operationId: `op-${sessionId}`,
          callerKey: 'caller',
          phase: 'committed'
        }
      }
    : base
}

let records = new Map<string, AgentSessionRecord>()
function installRecords(...list: AgentSessionRecord[]): void {
  records = new Map(list.map((entry) => [entry.sessionId, entry]))
  hostRef.current = {
    deps: {
      store: {
        getConversation: (sessionId: string) => {
          const found = records.get(sessionId)
          return found ? agentSessionConversationView(found) : null
        },
        listConversations: () => [...records.values()].map(agentSessionConversationView),
        getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [] })
      }
    },
    hasSession: (sessionId: string) => records.has(sessionId)
  }
}

let db: InstanceType<typeof OrchestrationDb>
beforeEach(() => {
  vi.useFakeTimers({ now: Date.now(), toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  db = new OrchestrationDb(':memory:')
  installRecords(
    record(A, 'Release plan', A_LIVE),
    record(A_LIVE, 'Release plan'),
    record(B, '  Hourly release scan  '),
    record(C)
  )
})
afterEach(() => {
  db.close()
  hostRef.current = null
  sessions.clear()
  vi.useRealTimers()
})

const address = formatOrcaSessionAddress
const microtasks = async () => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve()
  }
}

function workerBy(creator: OrcaSessionId, createdAgo = 0): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Scan' })
  const id = db.createStartingWorkerDispatch({
    creator: { kind: 'session', orcaSessionId: creator },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'codex' }
  }).dispatch.id
  if (createdAgo) {
    db.db
      .prepare(
        "UPDATE worker_dispatches SET created_at = datetime(?, 'unixepoch') WHERE dispatch_id = ?"
      )
      .run(Math.floor((Date.now() - createdAgo) / 1000), id)
  }
  return id
}
function settle(id: string, state: string, ago = 0) {
  db.db
    .prepare('UPDATE worker_dispatches SET state = ?, updated_at = ? WHERE dispatch_id = ?')
    .run(state, new Date(Date.now() - ago).toISOString(), id)
}
function handoff(from: string, to: string, extra: Record<string, unknown> = {}) {
  return db.insertMessage({ from, to, subject: 'Run the scan', type: 'handoff', ...extra })
}
const read = (party = address(A), currentOnly = true) =>
  readWorkerDock(db, { party, direction: 'around', currentOnly })
const rows = (snapshot: WorkerDockSnapshot = read()) =>
  (snapshot.elsewhere ?? []).map((row) => [row.source, row.running])
const relations = () =>
  db.db.prepare('SELECT source, target, last_at FROM worker_dock_delegations').all()

/** A pane-status runtime: with no status a refreshed ready worker reads as dead; `statuses` sets one. */
function deadRuntime() {
  const listeners = new Set<(pane: string) => void>()
  const statuses = new Map<string, unknown[]>()
  return {
    statuses,
    readAgentStatusOfPanes: (panes: string[]) => panes.flatMap((pane) => statuses.get(pane) ?? []),
    readObservedAgentStatusPaneIdentityFn: () => null,
    getAgentStatusTerminalHandleForPaneKey: () => null,
    getTerminalProcessIncarnation: () => null,
    subscribeAgentStatusRowChanges: (listener: (pane: string) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listeners,
    /** The pane reports fresh work, as a recovered worker's does. */
    recover(pane: string) {
      statuses.set(pane, [
        {
          paneKey: pane,
          state: 'working',
          structuredHost: 'owned',
          receivedAt: Date.now(),
          stateStartedAt: Date.now(),
          restoredUnconfirmed: false,
          providerSessionOnly: false
        }
      ])
      for (const listener of listeners) {
        listener(pane)
      }
    }
  }
}

/** A live session whose status row is in `paneKey`. */
function liveSession(paneKey: string): FleetSessionObservation {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the activity refresh reads only the live session's pane key from its evidence.
  return { status: 'live', activity: { activity: { paneKey } } } as FleetSessionObservation
}

/** A ready structured worker of `creator` in `pane`, its session's verdict set by the test. */
function readyWorker(
  creator: OrcaSessionId,
  handle: string,
  createdAgo: number,
  changedAgo: number
) {
  const id = workerBy(creator, createdAgo)
  settle(id, 'ready', changedAgo)
  db.db
    .prepare('UPDATE worker_dock_facts SET changed_at = ? WHERE dispatch_id = ?')
    .run(Date.now() - changedAgo, id)
  db.db
    .prepare('UPDATE dispatch_contexts SET assignee_handle = ?, assignee_pane_key = ? WHERE id = ?')
    .run(handle, `pane_${handle}`, id)
  return id
}

describe('recording handoff mail', () => {
  it('records a handoff by session address against both chats’ /clear roots', () => {
    handoff(address(A_LIVE), address(B))
    expect(relations()).toEqual([expect.objectContaining({ source: A, target: B })])
  })

  it('records nothing for a question, for mail to the own lineage, or for a group fan-out', () => {
    db.insertMessage({ from: address(A), to: address(B), subject: 'Q', type: 'question' })
    handoff(address(A), address(A_LIVE))
    handoff(address(A), address(B), { delegation: false })
    expect(relations()).toEqual([])
  })

  it('stores a handoff and its relation together, or neither', () => {
    const count = () =>
      db.db.prepare("SELECT count(*) AS n FROM messages WHERE type = 'handoff'").get()?.n
    db.db.exec('DROP TABLE worker_dock_delegations')
    expect(() => handoff(address(A), address(B))).toThrow()
    expect(count()).toBe(0)
    expect(db.db.isTransaction).toBe(false)
  })

  it('keeps the chat the sender addressed when routing rewrote the recipient', () => {
    const dispatch = workerBy(C)
    handoff(address(A), `dispatch:${dispatch}`, { addressedSession: B })
    expect(relations()).toEqual([expect.objectContaining({ source: A, target: B })])
  })

  it('resolves a stored dispatch recipient to its assignee chat', () => {
    const dispatch = workerBy(C)
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run(B, dispatch)
    handoff(address(A), `dispatch:${dispatch}`)
    expect(relations()).toEqual([expect.objectContaining({ target: B })])
  })

  it('resolves a Run to its current chat, never to a former chat of a terminal-bound Run', () => {
    const run = db.createRun({
      objective: 'Scan',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    db.db
      .prepare(
        `UPDATE runs SET coordinator_orca_session_id = ?, coordinator_orca_session_id_generation = consumer_generation
         WHERE id = ?`
      )
      .run(B, run.id)
    handoff(address(A), `run:${run.id}`)
    expect(relations()).toEqual([expect.objectContaining({ target: B })])
    db.db.prepare('DELETE FROM worker_dock_delegations').run()
    db.db
      .prepare(
        `UPDATE runs SET coordinator_orca_session_id = NULL, coordinator_handle = 'term_1',
         consumer_generation = consumer_generation + 1 WHERE id = ?`
      )
      .run(run.id)
    db.db
      .prepare(
        'INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle) VALUES (?, ?)'
      )
      .run(run.id, address(B))
    handoff(address(A), `run:${run.id}`)
    expect(relations()).toEqual([])
  })

  it('uses an unbound Run’s former chat only when its aliases name one chat', () => {
    const run = db.createRun({
      objective: 'Scan',
      coordinatorHandle: null,
      coordinatorPaneKey: null
    })
    db.db
      .prepare('INSERT INTO run_coordinator_handles (run_id, terminal_handle) VALUES (?, ?)')
      .run(run.id, address(B))
    handoff(address(A), `run:${run.id}`)
    expect(relations()).toEqual([expect.objectContaining({ target: B })])
    db.db.prepare('DELETE FROM worker_dock_delegations').run()
    db.db
      .prepare('INSERT INTO run_coordinator_handles (run_id, terminal_handle) VALUES (?, ?)')
      .run(run.id, address(C))
    handoff(address(A), `run:${run.id}`)
    expect(relations()).toEqual([])
  })
})

describe('Other chats rows', () => {
  it('counts the running workers of a chat it handed work to, named and openable, until they finish', () => {
    handoff(address(A), address(B))
    const first = workerBy(B)
    const second = workerBy(B)
    workerBy(C)
    const snapshot = read(address(A_LIVE))
    expect(snapshot.elsewhere).toEqual([
      {
        source: B,
        sessionId: B,
        title: 'Hourly release scan',
        workspaceId: 'workspace-1',
        running: 2
      }
    ])
    expect(snapshot.relations).toBe(true)
    expect(db.workerDockSources.read(A)?.open).toBe(true)
    // B's own island is untouched: its workers are its own.
    expect(read(address(B)).elsewhere).toBeUndefined()
    settle(first, 'succeeded')
    settle(second, 'failed')
    expect(rows()).toEqual([])
  })

  it('never counts the chat’s own workers or anything on a full (non-current) read', () => {
    handoff(address(A), address(B))
    workerBy(A)
    workerBy(B)
    expect(rows()).toEqual([[B, 1]])
    expect(read(address(A), false).elsewhere).toBeUndefined()
  })

  it('counts only workers created no later than a day after the newest handoff', () => {
    handoff(address(A), address(B))
    db.db.prepare('UPDATE worker_dock_delegations SET last_at = ?').run(Date.now() - 3 * DAY)
    workerBy(B, 2 * DAY + 60_000)
    expect(rows()).toEqual([[B, 1]])
    workerBy(B)
    expect(rows()).toEqual([[B, 1]])
  })

  it('shows a working chat even when many recent relations have no work', () => {
    const others = Array.from({ length: 8 }, (_, i) =>
      testOrcaSessionId(`5e6f7a8b-9cad-4ebf-8a${i}b-4c5d6e7f8a9b`)
    )
    for (const other of others) {
      handoff(address(A), address(other))
    }
    handoff(address(A), address(B))
    workerBy(B)
    expect(rows()).toEqual([[B, 1]])
  })

  it('reads both arms through the source/state index', () => {
    const plan = db.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT d.target FROM worker_dock_delegations d
         JOIN worker_dock_facts f INDEXED BY worker_dock_source_state_time
           ON f.source = d.target AND f.state IN ('starting', 'ready', 'stopping')
         WHERE d.source = ?`
      )
      .all(A)
      .map((row) => String(row.detail))
    expect(plan.join('\n')).toContain('worker_dock_source_state_time')
  })
})

describe('aging and recovery of other chats’ workers', () => {
  it('ages out a dead ready worker after a day without touching the owning chat’s own activity', () => {
    handoff(address(A), address(B))
    db.db.prepare('UPDATE worker_dock_delegations SET last_at = ?').run(Date.now() - 3 * DAY)
    readyWorker(B, 'structworker_dead', 2 * DAY + 60_000, 2 * DAY)
    sessions.set('structworker_dead', { status: 'exited' })
    const runtime = deadRuntime()
    const ownVersion = db.workerDockSources.version(B)
    const aged = readWorkerDock(
      db,
      { party: address(A), direction: 'around', currentOnly: true },
      {
        refreshElsewhere: (ready) => {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in pane-status runtime with only the members the activity refresh reads.
          refreshWorkerDockElsewhereActivity(db, A, ready, runtime as never)
        }
      }
    )
    expect(aged.elsewhere).toBeUndefined()
    expect(aged.hasUnverifiedElsewhere).toBe(true)
    // The island stays open to watch it, like a chat's own unverified worker.
    expect(db.workerDockSources.read(A)?.open).toBe(true)
    // Refreshing another chat's workers writes neither its activity nor its version.
    expect(readWorkerDockActivity(db, B)).toBeUndefined()
    expect(db.workerDockSources.version(B)).toBe(ownVersion)
  })

  it('shows the aged-out worker again when its pane recovers, with no change to its record', async () => {
    handoff(address(A), address(B))
    db.db.prepare('UPDATE worker_dock_delegations SET last_at = ?').run(Date.now() - 3 * DAY)
    readyWorker(B, 'structworker_back', 2 * DAY + 60_000, 2 * DAY)
    sessions.set('structworker_back', { status: 'exited' })
    // The handoff's own wake is spent first: only the pane may wake the island below.
    await microtasks()
    const runtime = deadRuntime()
    const seen: WorkerDockSnapshot[] = []
    const stop = subscribeWorkerDock(
      db,
      address(A),
      (value) => seen.push(value),
      undefined,
      true,
      true,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in pane-status runtime with only the members the activity refresh reads.
      workerDockElsewhereActivitySource(db, A, runtime as never)
    )
    expect(seen.at(-1)?.hasUnverifiedElsewhere).toBe(true)
    sessions.set('structworker_back', liveSession('pane_structworker_back'))
    runtime.recover('pane_structworker_back')
    await microtasks()
    expect(rows(seen.at(-1))).toEqual([[B, 1]])
    stop()
    expect(runtime.listeners.size).toBe(0)
  })

  it('keeps each reading chat’s view of the same owner apart', () => {
    const runtime = deadRuntime()
    const first = readyWorker(B, 'structworker_one', 0, 0)
    const second = readyWorker(B, 'structworker_two', 0, 0)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in pane-status runtime with only the members the activity refresh reads.
    refreshWorkerDockElsewhereActivity(db, C, new Map([[B, [first, second]]]), runtime as never)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in pane-status runtime with only the members the activity refresh reads.
    refreshWorkerDockElsewhereActivity(db, A, new Map([[B, [first]]]), runtime as never)
    expect([...(readWorkerDockElsewhereActivity(db, C, B)?.keys() ?? [])].sort()).toEqual(
      [first, second].sort()
    )
    expect([...(readWorkerDockElsewhereActivity(db, A, B)?.keys() ?? [])]).toEqual([first])
  })

  it('counts a ready worker whose activity was never read (as its own island does)', () => {
    handoff(address(A), address(B))
    const worker = workerBy(B)
    settle(worker, 'ready', 2 * DAY)
    expect(rows()).toEqual([[B, 1]])
  })

  it('keeps presence open when an older client reads the full roster after a current read', () => {
    handoff(address(A), address(B))
    workerBy(B)
    read()
    expect(db.workerDockSources.read(A)?.open).toBe(true)
    read(address(A), false)
    expect(db.workerDockSources.read(A)?.open).toBe(true)
  })
})

describe('waking after the mail commits', () => {
  it('wakes the sender once the mail commits, and not at all after a rollback', async () => {
    const invalidated: string[] = []
    const original = db.workerDockSources.invalidate.bind(db.workerDockSources)
    db.workerDockSources.invalidate = (source, membership) => {
      invalidated.push(source)
      original(source, membership)
    }
    db.db.exec('SAVEPOINT outer_send')
    handoff(address(A), address(B))
    db.db.exec('ROLLBACK TO outer_send')
    db.db.exec('RELEASE outer_send')
    await microtasks()
    expect(relations()).toEqual([])
    expect(invalidated).toEqual([])
    handoff(address(A), address(B))
    await microtasks()
    expect(invalidated).toEqual([A])
  })

  it('waits out a transaction held across many retries, then wakes after a quiet commit', async () => {
    const notified: unknown[] = []
    const stop = db.crewChanges.subscribe((facets) => notified.push(facets))
    db.db.exec('BEGIN')
    handoff(address(A), address(B))
    notified.length = 0
    for (let i = 0; i < 30; i++) {
      await microtasks()
      await vi.advanceTimersByTimeAsync(1000)
    }
    expect(notified).toEqual([])
    expect(workerDockDelegationWake(db).armed).toBe(true)
    db.db.exec('COMMIT')
    await vi.advanceTimersByTimeAsync(1000)
    expect(notified.length).toBeGreaterThan(0)
    expect(workerDockDelegationWake(db).armed).toBe(false)
    stop()
  })

  it('leaves no timer once the database closes', async () => {
    db.db.exec('BEGIN')
    handoff(address(A), address(B))
    await microtasks()
    const wake = workerDockDelegationWake(db)
    expect(wake.armed).toBe(true)
    db.db.exec('ROLLBACK')
    db.close()
    expect(wake.armed).toBe(false)
    db = new OrchestrationDb(':memory:')
  })
})

describe('backfilling earlier bot handoffs', () => {
  function botRequest(messageId: string) {
    db.db
      .prepare(
        `INSERT INTO bot_requests (message_id, root_key, to_bot_id, purpose, depth, record)
         VALUES (?, 'root', 'bot-b', 'handoff', 1, '{}')`
      )
      .run(messageId)
  }
  function earlierMail(from: string, to: string, ago: number) {
    db.db.prepare('DELETE FROM worker_dock_delegations_backfill').run()
    const message = db.insertMessage({ from, to, subject: 'Earlier', type: 'handoff' })
    db.db
      .prepare("UPDATE messages SET created_at = datetime(?, 'unixepoch') WHERE id = ?")
      .run(Math.floor((Date.now() - ago) / 1000), message.id)
    db.db.prepare('DELETE FROM worker_dock_delegations').run()
    return message.id
  }

  it('backfills only bot handoffs, at their own time, once', () => {
    botRequest(earlierMail(address(A), address(B), 2 * DAY))
    // Ordinary handoff mail could be one recipient of a group send: never backfilled.
    earlierMail(address(A), address(C), DAY)
    db.db.prepare('DELETE FROM worker_dock_delegations_backfill').run()
    db.db.prepare('DELETE FROM worker_dock_delegations').run()
    expect(backfillWorkerDockDelegations(db)).toEqual([])
    const rowsAfter = relations()
    expect(rowsAfter).toEqual([expect.objectContaining({ source: A, target: B })])
    expect(Number(rowsAfter[0]!.last_at)).toBeLessThan(Date.now() - DAY)
    expect(workerDockDelegationsBackfilled(db)).toBe(true)
    expect(backfillWorkerDockDelegations(db)).toBeNull()
  })

  it('asks a chat with an old relation and an aged-out counted worker to look again', () => {
    botRequest(earlierMail(address(A), address(B), 2 * DAY))
    const worker = workerBy(B, 2 * DAY - 60_000)
    settle(worker, 'ready', 2 * DAY)
    db.db.prepare('DELETE FROM worker_dock_delegations_backfill').run()
    db.db.prepare('DELETE FROM worker_dock_delegations').run()
    expect(backfillWorkerDockDelegations(db)).toEqual([A])
  })

  it('asks a chat with a relation younger than a day, and no work yet, to look again', () => {
    botRequest(earlierMail(address(A), address(B), 60 * 60_000))
    db.db.prepare('DELETE FROM worker_dock_delegations_backfill').run()
    db.db.prepare('DELETE FROM worker_dock_delegations').run()
    expect(backfillWorkerDockDelegations(db)).toEqual([A])
  })

  it('never backfills inside a read’s enclosing transaction; it commits on its own afterwards', async () => {
    botRequest(earlierMail(address(A), address(B), 60 * 60_000))
    db.db.prepare('DELETE FROM worker_dock_delegations_backfill').run()
    db.db.prepare('DELETE FROM worker_dock_delegations').run()
    await microtasks()
    db.db.exec('BEGIN')
    read()
    expect(workerDockDelegationsBackfilled(db)).toBe(false)
    db.db.exec('ROLLBACK')
    await vi.advanceTimersByTimeAsync(1000)
    expect(workerDockDelegationsBackfilled(db)).toBe(true)
    expect(relations()).toEqual([expect.objectContaining({ source: A, target: B })])
  })

  it('backfills when the session host arrives, and stops watching it when the database closes', () => {
    hostListeners.clear()
    watchWorkerDockBackfillHost(db)
    expect(hostListeners.size).toBe(1)
    db.close()
    expect(hostListeners.size).toBe(0)
    db = new OrchestrationDb(':memory:')
  })

  it('waits for the chats’ lineage, and a current read meanwhile does not count as seeded', () => {
    botRequest(earlierMail(address(A), address(B), DAY))
    db.db.prepare('DELETE FROM worker_dock_delegations_backfill').run()
    db.db.prepare('DELETE FROM worker_dock_delegations').run()
    hostRef.current = null
    expect(backfillWorkerDockDelegations(db)).toBeNull()
    read()
    expect(db.workerDockSources.needsSeed(A)).toBe(true)
    installRecords(record(A), record(B))
    read()
    expect(relations()).toEqual([expect.objectContaining({ source: A, target: B })])
    expect(db.workerDockSources.needsSeed(A)).toBe(false)
  })
})

describe('retention and resets', () => {
  it('prunes an idle month-old relation but keeps one whose worker still runs', () => {
    handoff(address(A), address(B))
    handoff(address(A), address(C))
    db.db.prepare('UPDATE worker_dock_delegations SET last_at = ?').run(Date.now() - 31 * DAY)
    workerBy(C, 31 * DAY - 60_000)
    // The hourly prune runs on the next handoff from A.
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
    handoff(address(A), address(testOrcaSessionId('6f7a8b9c-adbe-4fca-9b0c-5d6e7f8a9b0c')))
    expect(relations().map((row) => row.target)).toContain(C)
    expect(relations().map((row) => row.target)).not.toContain(B)
  })

  it('clears relations with the mail they came from', () => {
    handoff(address(A), address(B))
    db.resetMessages()
    expect(relations()).toEqual([])
    handoff(address(A), address(B))
    db.resetTasks()
    expect(relations()).toHaveLength(1)
    db.resetAll()
    expect(relations()).toEqual([])
  })
})

describe('an open island’s stream', () => {
  function open(runtime = deadRuntime()) {
    const seen: WorkerDockSnapshot[] = []
    const stop = subscribeWorkerDock(
      db,
      address(A),
      (value) => seen.push(value),
      undefined,
      true,
      true,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a stand-in pane-status runtime with only the members the activity refresh reads.
      workerDockElsewhereActivitySource(db, A, runtime as never)
    )
    return { seen, stop, runtime, latest: () => seen.at(-1)! }
  }

  it('shows a handoff and the other chat’s new worker, and ignores unrelated worker changes', async () => {
    const stream = open()
    expect(rows(stream.latest())).toEqual([])
    handoff(address(A), address(B))
    await microtasks()
    workerBy(B)
    await microtasks()
    expect(rows(stream.latest())).toEqual([[B, 1]])
    const reads = vi.spyOn(db.db, 'prepare')
    const before = stream.seen.length
    workerBy(C)
    await microtasks()
    expect(stream.seen.length).toBe(before)
    // A committed-revision check and the bounded comparison ran, not a full read.
    const sql = reads.mock.calls.map(([text]) => String(text))
    expect(sql.some((text) => text.includes('SELECT revision FROM worker_dock_revision'))).toBe(
      true
    )
    expect(sql.some((text) => text.includes('max(last_at)'))).toBe(false)
    reads.mockRestore()
    stream.stop()
  })

  it('runs no SQL inside the change notice, which may come from an uncommitted transaction', async () => {
    handoff(address(A), address(C))
    workerBy(B)
    const stream = open()
    db.db.exec('BEGIN')
    const reads = vi.spyOn(db.db, 'prepare')
    handoff(address(A), address(B))
    await microtasks()
    const revisionReads = () =>
      reads.mock.calls.filter(([text]) => String(text).includes('FROM worker_dock_revision')).length
    expect(revisionReads()).toBe(0)
    db.db.exec('COMMIT')
    await vi.advanceTimersByTimeAsync(1000)
    await microtasks()
    reads.mockRestore()
    expect(rows(stream.latest())).toEqual([[B, 1]])
    stream.stop()
  })

  it('reads again after a transaction that ends with no further notice', async () => {
    handoff(address(A), address(B))
    const worker = workerBy(B)
    await microtasks()
    const stream = open()
    expect(rows(stream.latest())).toEqual([[B, 1]])
    db.db.exec('BEGIN')
    settle(worker, 'succeeded')
    db.crewChanges.notify()
    await microtasks()
    db.db.exec('COMMIT')
    await vi.advanceTimersByTimeAsync(1000)
    expect(rows(stream.latest())).toEqual([])
    stream.stop()
  })

  it('touches nothing once the database closes under it', async () => {
    handoff(address(A), address(B))
    await microtasks()
    const stream = open()
    db.db.exec('BEGIN')
    db.crewChanges.notify()
    await microtasks()
    db.close()
    await expect(vi.advanceTimersByTimeAsync(5000)).resolves.not.toThrow()
    stream.stop()
    db = new OrchestrationDb(':memory:')
  })

  it('renames a row when the owning chat is renamed or the session store is replaced', async () => {
    const stream = open()
    handoff(address(A), address(B))
    workerBy(B)
    await microtasks()
    expect(stream.latest().elsewhere?.[0]?.title).toBe('Hourly release scan')
    records.set(B, record(B, 'Renamed scan'))
    sessionCrewChanges.notify(Object.assign(new Set(['names'] as const), { recordIds: [B] }))
    await microtasks()
    expect(stream.latest().elsewhere?.[0]?.title).toBe('Renamed scan')
    records.set(B, record(B, 'Store reopened'))
    sessionCrewChanges.notify(new Set(['topology', 'records']))
    await microtasks()
    expect(stream.latest().elsewhere?.[0]?.title).toBe('Store reopened')
    stream.stop()
  })
})
