import { mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import { formatOrcaSessionAddress, type OrcaSessionId } from '../../shared/orca-session-address'
import { testOrcaSessionId } from '../../shared/orca-session-address-test-fixture'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import {
  installSqlVisitCounters,
  traceDispatchPredicateVisits,
  latestStatementMetrics,
  dispatchQueryPlans,
  seedCoarsePresentationDispatches
} from './dispatch-predicate-visits.test-fixture'

export function benchmarkPresentationCorpus(
  corpus: {
    nullAddress: boolean
    history: number
    terminalHistory: number
    attentionFacts: number
    parentSessionId: OrcaSessionId
  },
  build: (
    db: OrchestrationDb
  ) => Record<string, { parentPaneKey?: string | null; dispatchId: string }> | undefined
) {
  const { nullAddress, history, terminalHistory, attentionFacts, parentSessionId } = corpus
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const now = Date.parse('2026-10-27T12:00:00Z')
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  const directory = mkdtempSync(join(tmpdir(), 'orca-lineage-benchmark-'))
  const path = join(directory, 'orchestration.sqlite')
  let db = new OrchestrationDb(path)
  let native: ReturnType<typeof installSqlVisitCounters> | undefined
  let trace: ReturnType<typeof traceDispatchPredicateVisits> | undefined
  try {
    const run = db.createRun({
      objective: 'benchmark',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: parentSessionId
    })
    const expected = new Map<string, string>()
    for (let i = 0; i < 20; i++) {
      const session = testOrcaSessionId(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
      const dispatch = db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: 'active' }).id,
        assigneeHandle: formatOrcaSessionAddress(session),
        creator: { kind: 'system' },
        maxDepth: 99
      })
      expected.set(
        structuredAgentSessionPaneKey(structuredAgentSessionTabId(session), session),
        dispatch.id
      )
    }
    if (nullAddress) {
      db.db.exec(
        "UPDATE dispatch_contexts SET assignee_handle = NULL, assignee_pane_key = NULL WHERE status IN ('pending', 'dispatched')"
      )
    }
    const task = db.createTask({ runId: run.id, spec: 'history' })
    const insert = db.db.prepare(`INSERT INTO dispatch_contexts
      (id, run_id, task_id, assignee_handle, assignee_orca_session_id, status, completed_at)
      WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n < ?)
      SELECT ? || n, ?, ?, CASE WHEN ? THEN printf('orca_session_id:00000000-0000-4000-8000-%012d', (n-1) % 20) ELSE 'terminal-address-' || n END,
        CASE WHEN ? THEN CASE WHEN ? THEN printf('00000000-0000-4000-8000-%012d', (n-1) % 20) ELSE 'session-' || n END ELSE NULL END,
        'completed', '2020-01-01T00:00:00Z' FROM seq`)
    insert.run(history, 'session-history-', run.id, task.id, 1, 1, nullAddress ? 1 : 0)
    if (terminalHistory) {
      insert.run(terminalHistory, 'terminal-history-', run.id, task.id, 0, 0, 0)
    }
    const active = db.db
      .prepare(
        "SELECT id, task_id FROM dispatch_contexts WHERE status IN ('pending', 'dispatched') ORDER BY rowid"
      )
      .all()
    expect(active.map((row) => row.id)).toEqual([...expected.values()])
    const insertFact = db.db.prepare(
      `INSERT INTO attempt_observation_facts(id, dispatch_id, task_id, sequence, authority_id, authority_clock, facet, payload, home_received_at) VALUES (?, ?, ?, ?, 'home', 'home', 'process_turn', '{"process":"running","turn":"working"}', ?)`
    )
    for (let i = 0; i < attentionFacts; i++) {
      const row = active[i % active.length]
      if (typeof row?.id !== 'string' || typeof row.task_id !== 'string') {
        throw new Error('Missing benchmark Dispatch')
      }
      insertFact.run(
        `observation-${i}`,
        row.id,
        row.task_id,
        Math.floor(i / active.length),
        1_800_000_000_000 + i
      )
    }
    const sqlite = db.db.prepare('SELECT sqlite_version() AS version').get()?.version
    db.db.exec('DROP INDEX idx_dispatch_session_presentation')
    const first = performance.now()
    db.createMailboxDeliveryIndexesIfPossible()
    const indexHelperMs = performance.now() - first
    db.db.exec('DROP INDEX idx_dispatch_session_presentation')
    db.close()
    const openStarted = performance.now()
    db = new OrchestrationDb(path)
    const reopenWithIndexCreationMs = performance.now() - openStarted
    let candidateVisits = 0,
      latestVisits = 0,
      observationVisits = 0
    native = installSqlVisitCounters({
      lineage_bench_visit: () => {
        candidateVisits++
        return 1
      },
      lineage_latest_visit: () => {
        latestVisits++
        return 1
      },
      lineage_observation_visit: () => {
        observationVisits++
        return 1
      }
    })
    trace = traceDispatchPredicateVisits(db.db, {
      candidate: 'lineage_bench_visit',
      latest: 'lineage_latest_visit',
      observation: 'lineage_observation_visit'
    })
    let plans: ReturnType<typeof dispatchQueryPlans> | undefined
    let previousCoarse = 0
    const sweep =
      !nullAddress && history === 10_000 && terminalHistory === 0 && attentionFacts === 0
    for (const coarseOnly of sweep ? [0, 1_000, 10_000] : [0]) {
      seedCoarsePresentationDispatches(
        db,
        run.id,
        coarseOnly - previousCoarse,
        now,
        `coarse-${coarseOnly}`
      )
      previousCoarse = coarseOnly
      trace.mockClear()
      trace.executions.length = 0
      native.mockClear()
      candidateVisits = 0
      latestVisits = 0
      observationVisits = 0
      const start = performance.now()
      const output = build(db)
      const buildMs = performance.now() - start
      const production = {
        cachedPrepareCalls: trace.mock.calls.length,
        executedStatements: trace.executions.length,
        nativeCompilations: native.mock.calls.length,
        latest: latestStatementMetrics(trace, native),
        candidateVisits,
        latestVisits,
        observationVisits
      }
      expect(production.latest).toEqual({
        cachedPrepareCalls: nullAddress ? 0 : 1,
        executedStatements: nullAddress ? 0 : 1,
        nativeCompilations: nullAddress || coarseOnly ? 0 : 1,
        addressEntries: nullAddress ? 0 : 20,
        returnedVerificationRows: nullAddress ? 0 : 20
      })
      expect(
        trace.executions.filter(
          ({ query }) =>
            query.includes('rowid AS n') &&
            query.includes('assignee_orca_session_id') &&
            query.includes("AND status IN ('pending', 'dispatched')")
        )
      ).toHaveLength(0)
      expect(Object.keys(output ?? {}).sort()).toEqual([...expected.keys()].sort())
      for (const [key, dispatchId] of expected) {
        expect(output?.[key]).toMatchObject({
          dispatchId,
          parentPaneKey: structuredAgentSessionPaneKey(
            structuredAgentSessionTabId(parentSessionId),
            parentSessionId
          )
        })
      }
      expect(candidateVisits).toBe(20 + coarseOnly)
      expect(latestVisits).toBe(nullAddress ? 0 : 20)
      expect(observationVisits).toBe(attentionFacts)
      if (!plans) {
        plans = dispatchQueryPlans(db.db, trace)
      }
      const planText = JSON.stringify(plans)
      expect(planText).not.toMatch(/SCAN dispatch_contexts|USE TEMP B-TREE/)
      expect(planText).toContain('idx_dispatch_session_presentation (status=? AND completed_at>?)')
      if (!nullAddress) {
        expect(planText).toContain('idx_dispatch_active_assignee_handle (assignee_handle=?)')
      }
      console.log(
        'LINEAGE_BENCH_ENVIRONMENT_EVIDENCE',
        JSON.stringify({
          host: hostname(),
          node: process.version,
          sqlite,
          platform: process.platform,
          arch: process.arch,
          checkout: process.cwd(),
          revision,
          timingScope: 'instrumented production build; includes predicate/tracing overhead',
          corpus,
          coarseOnly,
          Q: 20 + coarseOnly,
          E: nullAddress ? 0 : 20,
          B: nullAddress ? 0 : 1,
          cachePhase: coarseOnly
            ? 'warm statements after coarse-only inserts'
            : 'first instrumented build after constructor reopen',
          indexHelperMs,
          reopenWithIndexCreationMs,
          buildMs,
          production,
          diagnostic: {
            cachedPrepareCalls: trace.mock.calls.length - production.cachedPrepareCalls,
            executedStatements: trace.executions.length - production.executedStatements,
            nativeCompilations: native.mock.calls.length - production.nativeCompilations
          },
          plans
        })
      )
    }
  } finally {
    trace?.mockRestore()
    native?.mockRestore()
    clock.mockRestore()
    db.close()
    rmSync(directory, { recursive: true, force: true })
  }
}
