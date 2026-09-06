import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RuntimeAgentOrchestrationProjection } from '../../runtime-agent-orchestration-projection'
import type { OrchestrationCompatibilityTerminalAuthority } from '../../runtime-terminal-contracts'
import type { RuntimeLeafRecord } from '../../runtime-terminal-state-records'
import { OrchestrationDb } from '../db'
import { createRootDispatch } from './root-dispatch-test-fixture'

const COORDINATOR_HANDLE = 'term_coordinator'
const COORDINATOR_PANE = 'tab_c:leaf_c'
const WORKER_HANDLE = 'term_worker'
const WORKER_PANE = 'tab_w:leaf_w'
const IDLE_HANDLE = 'term_idle'
const IDLE_PANE = 'tab_i:leaf_i'

// Why: mirrors SyncDatabase's `isStatementCacheable` — aggregate `(*)` is fine, any other `*` is not.
const WILDCARD_PROJECTION = /(?<!\(\s*)\*/

const openDatabases: OrchestrationDb[] = []
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    try {
      db.close()
    } catch {
      // already closed by the test
    }
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function openDatabase(path: string): OrchestrationDb {
  const db = new OrchestrationDb(path)
  openDatabases.push(db)
  return db
}

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-orchestration-hot-path-'))
  temporaryDirectories.push(directory)
  return join(directory, 'orchestration.db')
}

/** Counts real SQL compilations by wrapping the node:sqlite handle SyncDatabase prepares against. */
function trackCompiledSql(db: OrchestrationDb): string[] {
  const inner = (db.db as unknown as { db: { prepare(sql: string): unknown } }).db
  const original = inner.prepare.bind(inner)
  const compiled: string[] = []
  inner.prepare = (sql: string) => {
    compiled.push(sql)
    return original(sql)
  }
  return compiled
}

function seedDispatchedWorker(db: OrchestrationDb): void {
  const run = db.createRun({
    objective: 'demo',
    coordinatorHandle: COORDINATOR_HANDLE,
    coordinatorPaneKey: COORDINATOR_PANE
  })
  const task = db.createTask({
    spec: 'ship the thing',
    runId: run.id,
    createdByTerminalHandle: COORDINATOR_HANDLE,
    createdByPaneKey: COORDINATOR_PANE,
    createdByProcessIncarnation: 'inc_1',
    createdByRunGeneration: run.consumer_generation
  })
  createRootDispatch(db, task.id, WORKER_HANDLE, WORKER_PANE)
}

function buildProjection(db: OrchestrationDb): RuntimeAgentOrchestrationProjection {
  const leaves = [{ ptyId: 'pty_w' }, { ptyId: 'pty_i' }] as unknown as RuntimeLeafRecord[]
  const handleByLeaf = new Map<RuntimeLeafRecord, string>([
    [leaves[0] as RuntimeLeafRecord, WORKER_HANDLE],
    [leaves[1] as RuntimeLeafRecord, IDLE_HANDLE]
  ])
  const paneByLeaf = new Map<RuntimeLeafRecord, string>([
    [leaves[0] as RuntimeLeafRecord, WORKER_PANE],
    [leaves[1] as RuntimeLeafRecord, IDLE_PANE]
  ])
  return new RuntimeAgentOrchestrationProjection({
    getDb: () => db,
    getLeaves: () => leaves,
    getPtys: () => [],
    issueLeafHandle: (leaf) => handleByLeaf.get(leaf) ?? '',
    issuePtyHandle: () => '',
    makePaneKey: (leaf) => paneByLeaf.get(leaf) ?? '',
    getWorktreeId: () => null,
    getHandleForPaneKey: (paneKey) => (paneKey === COORDINATOR_PANE ? COORDINATOR_HANDLE : null),
    getPaneKey: (handle) => (handle === COORDINATOR_HANDLE ? COORDINATOR_PANE : null),
    getDispatchAuthority: (handle) =>
      handle === COORDINATOR_HANDLE
        ? ({
            paneKey: COORDINATOR_PANE,
            processIncarnation: 'inc_1'
          } as OrchestrationCompatibilityTerminalAuthority)
        : null
  })
}

describe('orchestration hot-path statement compilation', () => {
  it('compiles each hot-path SQL exactly once across repeated graph publishes', () => {
    const db = openDatabase(':memory:')
    seedDispatchedWorker(db)
    const projection = buildProjection(db)
    const compiled = trackCompiledSql(db)

    const publishes = [projection.buildByPaneKey()]
    const compiledByFirstPublish = [...compiled]
    for (let publish = 0; publish < 4; publish += 1) {
      publishes.push(projection.buildByPaneKey())
    }

    const compilationsPerSql = new Map<string, number>()
    for (const sql of compiled) {
      compilationsPerSql.set(sql, (compilationsPerSql.get(sql) ?? 0) + 1)
    }
    expect([...compilationsPerSql].filter(([, count]) => count > 1)).toEqual([])
    expect(compiled).toEqual(compiledByFirstPublish)
    // Why: a cache that changed what the fan-out returns would be worse than the recompiles.
    expect(publishes[0]).toBeDefined()
    for (const publish of publishes) {
      expect(publish).toEqual(publishes[0])
    }
  })

  // Why: getTask sits on the dispatch/lifecycle path and listTasks runs several times per
  // coordinator tick, so a wildcard there recompiles on every call the same way the publish did.
  it('compiles the task lookup and listing SQL exactly once across repeated calls', () => {
    const db = openDatabase(':memory:')
    seedDispatchedWorker(db)
    const seeded = db.listTasks()
    expect(seeded.length).toBeGreaterThan(0)
    const taskId = seeded[0].id

    const compiled = trackCompiledSql(db)
    for (let call = 0; call < 5; call += 1) {
      db.getTask(taskId)
      db.listTasks()
      db.listTasks({ ready: true })
      db.listTasks({ status: 'pending' })
      db.listTasks({ runId: seeded[0].run_id })
    }

    const compilationsPerSql = new Map<string, number>()
    for (const sql of compiled) {
      compilationsPerSql.set(sql, (compilationsPerSql.get(sql) ?? 0) + 1)
    }
    expect([...compilationsPerSql].filter(([, count]) => count > 1)).toEqual([])
    expect(compiled.filter((sql) => WILDCARD_PROJECTION.test(sql))).toEqual([])
  })

  // Why: `SELECT *` is what made these statements uncacheable, and a retained wildcard is the only
  // way node:sqlite could build a row from stale column names after another connection's ALTER.
  // Seeds on one connection and publishes on a second so every compilation here is hot-path SQL.
  it('publishes without compiling a single wildcard projection', () => {
    const path = temporaryDatabasePath()
    seedDispatchedWorker(openDatabase(path))

    const reader = openDatabase(path)
    const compiled = trackCompiledSql(reader)
    buildProjection(reader).buildByPaneKey()

    expect(compiled.length).toBeGreaterThan(0)
    expect(compiled.filter((sql) => WILDCARD_PROJECTION.test(sql))).toEqual([])
  })
})
