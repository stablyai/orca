import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  getFollowUpDispatch,
  recordWorkerResumeSession
} from '../../../../orchestration/db/dispatch-context/worker-follow-up-lineage'
import { installSqlVisitCounters } from '../../../../dispatch-predicate-visits.test-fixture'
import { receipt, type Started, useHelperFollowUpCli } from './helper-follow-up-cli.test-support'

const HISTORY_INDEX = 'idx_dispatch_pane_leaf_history'

/** Each execution of the pane-history read, the rows its index ranges visited, and its query plan. */
function traceHistory(db: OrchestrationDb) {
  let visited = 0
  const native = installSqlVisitCounters({ pane_history_visit: () => ++visited })
  const prepare = db.db.prepare.bind(db.db)
  const executions: { query: string; parameters: unknown[] }[] = []
  const spy = vi.spyOn(db.db, 'prepare').mockImplementation((query) => {
    if (!query.startsWith('WITH holders AS')) {
      return prepare(query)
    }
    const statement = prepare(
      query.replaceAll('= ? AND host_scope', '= ? AND pane_history_visit(rowid) AND host_scope')
    )
    const all = statement.all.bind(statement)
    vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
      executions.push({ query, parameters })
      return all(...parameters)
    })
    return statement
  })
  return {
    reads: () => executions.length,
    visited: () => visited,
    expectIndexedPlans() {
      for (const { query, parameters } of executions) {
        const plan = prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all(...(parameters as string[]))
          .map((row) => String((row as { detail: string }).detail))
        // Two ranges of the history index, one owner probe per holder, and no table scan.
        expect(plan.filter((detail) => detail.includes(HISTORY_INDEX))).toHaveLength(2)
        expect(plan).toContainEqual(
          expect.stringMatching(/SEARCH r USING .*idx_worker_terminal_resources_owner/)
        )
        expect(plan.filter((detail) => /SCAN (dispatch_contexts|r)\b/.test(detail))).toEqual([])
      }
    },
    restore() {
      spy.mockRestore()
      native.mockRestore()
    }
  }
}

/** Shared steps over one fixture, for the in-memory and file-backed suites. */
function externalSteps(f: ReturnType<typeof useHelperFollowUpCli>) {
  const { h, start, report, takeOver } = f
  return {
    /** A worker the coordinator started on the user's own terminal starts a helper; both report. */
    async workerWithHelper(terminal: string) {
      const worker = await takeOver('term_coord', terminal)
      const helper = await start(terminal, `${terminal}_helper`)
      await report(`${terminal}_helper`, helper, `dispatch:${worker.dispatchId}`)
      await report(terminal, worker, 'term_coord')
      return { worker, helper }
    },
    /** `count` more coordinator assignments of the same terminal; the last one stays at work. */
    async assignments(terminal: string, count: number, settleLast = false) {
      let latest!: Started
      for (let step = 0; step < count; step++) {
        latest = await takeOver('term_coord', terminal)
        if (step < count - 1 || settleLast) {
          await report(terminal, latest, 'term_coord')
        }
      }
      return latest
    },
    terminalRows: (terminal: string) =>
      h.db.db
        .prepare(
          'SELECT ownership_state, prior_owner_dispatch_ids, auto_release_at FROM worker_terminal_resources WHERE terminal_handle = ?'
        )
        .all(terminal)
  }
}

describe('helpers of a worker on the user’s own terminal, through CLI argv, RPC and SQLite', () => {
  const f = useHelperFollowUpCli()
  const { h, success, start, report, follow, takeOver, continues, otherRun, effects, reopenOn } = f
  const { workerWithHelper, assignments, terminalRows } = externalSteps(f)

  it.each(['live', 'closed'] as const)(
    'lets a worker reopened on the user’s own terminal continue its %s helper, whatever the timestamps',
    async (state) => {
      const { worker, helper } = await workerWithHelper('term_user')
      if (state === 'closed') {
        await success('worker-release', '--dispatch', helper.dispatchId)
      }
      const reopened = await reopenOn(worker, 'term_user')
      // Second-resolution timestamps prove nothing; the order comes from acquisition alone.
      h.db.db.exec(`UPDATE dispatch_contexts SET created_at = '2000-01-01 00:00:00';
        UPDATE worker_terminal_resources SET created_at = '2000-01-01 00:00:00', updated_at = '2000-01-01 00:00:00'`)
      f.nextTerminal = 'term_helper_again'
      const continued = await continues('term_user', helper, reopened)
      await report(
        state === 'closed' ? 'term_helper_again' : 'term_user_helper',
        continued,
        `dispatch:${reopened.dispatchId}`
      )
      expect(h.db.getUnreadMessages(`dispatch:${reopened.dispatchId}`)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'worker_done' })])
      )
      // Still the user's terminal: never transferred, closed or scheduled for release.
      expect(terminalRows('term_user')).toEqual(
        Array(2).fill({
          ownership_state: 'external',
          prior_owner_dispatch_ids: '[]',
          auto_release_at: null
        })
      )
      expect(vi.mocked(h.runtime.closeTerminal).mock.calls.map(([handle]) => handle)).not.toContain(
        'term_user'
      )
    }
  )

  it('follows an external recovery, a follow-up in a new pane and a takeover together', async () => {
    const { worker, helper } = await workerWithHelper('term_user')
    const reopened = await reopenOn(worker, 'term_user')
    await report('term_user', reopened, 'term_coord')
    // The user's agent has exited; the coordinator's follow-up resumes its conversation in a pane Orca owns.
    recordWorkerResumeSession(
      h.db,
      h.db.getWorkerTerminalResourceByOwner(reopened.dispatchId)!.id,
      {
        paneKey: h.runtime.getTerminalPaneKey('term_user')!,
        agent: 'claude',
        processIncarnation: 'process:term_user',
        providerSession: { key: 'session_id', id: 'fixture-conversation' },
        observedAt: Date.now()
      }
    )
    vi.mocked(h.runtime.isTerminalRunningAgent).mockResolvedValueOnce(false)
    vi.spyOn(h.runtime, 'resumeAgentSessionInWorkspace').mockResolvedValue({
      ok: true,
      handle: 'term_resumed',
      paneKey: h.runtime.getTerminalPaneKey('term_resumed')!,
      ptyId: 'pty:term_resumed'
    })
    const resumed = receipt.parse((await follow('term_coord', reopened.dispatchId)).result)
    expect(h.db.getDispatchContextById(resumed.dispatchId)?.follow_up_of_dispatch_id).toBe(
      reopened.dispatchId
    )
    await report('term_resumed', resumed, 'term_coord')
    const taken = await takeOver('term_coord', 'term_resumed')
    expect(h.db.getWorkerTerminalResourceByOwner(taken.dispatchId)?.prior_owner_dispatch_ids).toBe(
      JSON.stringify([resumed.dispatchId])
    )
    await continues('term_resumed', helper, taken)
  })

  it('refuses when another Run took the user’s terminal between, even though that start was accepted later', async () => {
    const { worker, helper } = await workerWithHelper('term_user')
    otherRun()
    // The recovery is accepted first but takes the pane last.
    const wait = vi.mocked(h.runtime.waitForTerminal).getMockImplementation()!
    const entered = h.deferred<void>()
    const gate = h.deferred<void>()
    vi.mocked(h.runtime.waitForTerminal).mockImplementationOnce(async (...args) => {
      entered.resolve()
      await gate.promise
      return wait(...args)
    })
    const recovery = reopenOn(worker, 'term_user')
    await entered.promise
    const visitor = await takeOver('term_other_coord', 'term_user')
    await report('term_user', visitor, 'term_other_coord')
    gate.resolve()
    const reopened = await recovery
    const order = (table: string, column: string) =>
      h.db.db
        .prepare(`SELECT ${column} AS id FROM ${table} WHERE ${column} IN (?, ?) ORDER BY rowid`)
        .all(reopened.dispatchId, visitor.dispatchId)
    expect(order('dispatch_contexts', 'id')).toEqual([
      { id: reopened.dispatchId },
      { id: visitor.dispatchId }
    ])
    expect(order('worker_terminal_resources', 'owner_dispatch_id')).toEqual([
      { id: visitor.dispatchId },
      { id: reopened.dispatchId }
    ])
    const before = effects()
    expect((await follow('term_user', helper.dispatchId)).error).toMatchObject({
      code: 'task_not_found'
    })
    expect(effects()).toEqual(before)
  })

  it.each([
    'a direct dispatch to the same agent',
    'a replaced process',
    'another host',
    'a backfilled custody row',
    'unreadable custody history'
  ] as const)('refuses a worker reopened on the user’s terminal after %s', async (between) => {
    const { worker, helper } = await workerWithHelper('term_user')
    const earlier = h.db.getWorkerTerminalResourceByOwner(worker.dispatchId)!
    const authority = vi.mocked(h.runtime.getOrchestrationDispatchAuthority)
    const current = authority.getMockImplementation()!
    if (between === 'a direct dispatch to the same agent') {
      // The production dispatch writer records the agent's pane but no custody row and no host.
      const { task } = z
        .object({ task: z.object({ id: z.string() }) })
        .parse(await success('task-create', '--from', 'term_coord', '--spec', 'direct work'))
      await success(
        'dispatch',
        '--from',
        'term_coord',
        '--task',
        task.id,
        '--to',
        'term_user',
        '--inject'
      )
      const direct = h.db.getDispatchContext(task.id)!
      expect(direct).toMatchObject({ assignee_handle: 'term_user', host_scope: null })
      expect(h.db.getWorkerTerminalResourceByOwner(direct.id)).toBeUndefined()
      await report('term_user', { taskId: task.id, dispatchId: direct.id }, 'term_coord')
    }
    if (between === 'a replaced process' || between === 'another host') {
      authority.mockImplementation((handle) => ({
        ...current(handle)!,
        ...(between === 'a replaced process'
          ? { processIncarnation: `replaced:${handle}` }
          : { hostScope: { kind: 'local', hostId: 'elsewhere' } })
      }))
    }
    const corrupt = {
      'a backfilled custody row': ['retained_reason', 'legacy_ambiguous'],
      'unreadable custody history': ['prior_owner_dispatch_ids', 'not-json']
    }[between as string]
    if (corrupt) {
      h.db.db
        .prepare(`UPDATE worker_terminal_resources SET ${corrupt[0]} = ? WHERE id = ?`)
        .run(corrupt[1], earlier.id)
    }
    const reopened = await reopenOn(worker, 'term_user')
    const before = effects()
    expect((await follow('term_user', helper.dispatchId)).error).toMatchObject({
      code: 'task_not_found',
      message: expect.stringContaining(`is not a helper of Dispatch ${reopened.dispatchId}`)
    })
    expect(effects()).toEqual(before)
  })

  it('continues mail a worker reopened on the user’s terminal sent while its helper worked', async () => {
    const worker = await takeOver('term_coord', 'term_user')
    const helper = await start('term_user', 'term_helper')
    await report('term_user', worker, 'term_coord')
    const reopened = await reopenOn(worker, 'term_user')
    expect((await follow('term_user', helper.dispatchId)).error).toBeUndefined()
    await report('term_helper', helper, `dispatch:${worker.dispatchId}`)
    await vi.waitFor(() =>
      expect(getFollowUpDispatch(h.db, helper.dispatchId)?.creator_dispatch_id).toBe(
        reopened.dispatchId
      )
    )
  })

  it('reads the same history however much unrelated work is stored', async () => {
    const counts: { reads: number; visited: number }[] = []
    for (const unrelated of [40, 400]) {
      const terminal = `term_user_${unrelated}`
      const { worker, helper } = await workerWithHelper(terminal)
      const reopened = await reopenOn(worker, terminal)
      const pane = h.runtime.getTerminalPaneKey(terminal)!
      const host = h.db.getDispatchContextById(worker.dispatchId)!.host_scope
      const task = h.db.createTask({ runId: h.activeRunId, spec: 'unrelated history' })
      // Settled assignments of other panes, and of this pane's leaf on another host, with their custody rows.
      h.db.db
        .prepare(
          `INSERT INTO dispatch_contexts
             (id, run_id, task_id, assignee_handle, assignee_pane_key, process_incarnation, host_scope, status)
           WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < ?)
           SELECT 'unrelated_' || ? || '_' || n, ?, ?, 'term_unrelated',
                  CASE WHEN n % 4 = 0 THEN ? ELSE 'tab_unrelated:' || ? || '-' || n END, 'process:unrelated',
                  CASE WHEN n % 4 = 0 THEN 'another host' ELSE ? END, 'completed'
             FROM seq`
        )
        .run(unrelated, unrelated, h.activeRunId, task.id, pane, unrelated, host)
      h.db.db
        .prepare(
          `INSERT INTO worker_terminal_resources
             (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key, process_incarnation, host_scope, ownership_state)
           SELECT 'wtr_' || id, id, id, assignee_handle, assignee_pane_key, process_incarnation, host_scope, 'external'
             FROM dispatch_contexts WHERE id LIKE ?`
        )
        .run(`unrelated_${unrelated}_%`)
      const trace = traceHistory(h.db)
      await continues(terminal, helper, reopened)
      trace.expectIndexedPlans()
      counts.push({ reads: trace.reads(), visited: trace.visited() })
      trace.restore()
    }
    // One derivation, visiting only this pane's two assignments, at both sizes.
    expect(counts).toEqual([
      { reads: 1, visited: 2 },
      { reads: 1, visited: 2 }
    ])
  })

  it.each(['one pane', 'two panes joined by a follow-up'] as const)(
    'derives each pane’s history once however long the recovery chain (%s)',
    async (shape) => {
      for (const length of [3, 30]) {
        const first = `term_a_${length}`
        const { helper } = await workerWithHelper(first)
        let terminal = first
        if (shape === 'two panes joined by a follow-up') {
          const left = await assignments(first, length, true)
          // The agent left the first terminal; the user resumed its conversation in a second one, where the follow-up goes.
          terminal = `term_b_${length}`
          const session = { key: 'session_id', id: `conversation-${length}` }
          recordWorkerResumeSession(
            h.db,
            h.db.getWorkerTerminalResourceByOwner(left.dispatchId)!.id,
            {
              paneKey: h.runtime.getTerminalPaneKey(first)!,
              agent: 'claude',
              processIncarnation: `process:${first}`,
              providerSession: session,
              observedAt: Date.now()
            }
          )
          const resumedPane = h.runtime.getTerminalPaneKey(terminal)!
          h.runtime.getAgentStatusSnapshotFn = () =>
            [{ paneKey: resumedPane, agentType: 'claude', providerSession: session }] as never
          vi.spyOn(h.runtime, 'getTerminalHandleForPaneKey').mockImplementation((paneKey) =>
            paneKey === resumedPane ? terminal : null
          )
          vi.mocked(h.runtime.isTerminalRunningAgent).mockImplementation(
            async (handle) => handle !== first
          )
          const moved = receipt.parse((await follow('term_coord', left.dispatchId)).result)
          expect(h.db.getDispatchContextById(moved.dispatchId)?.follow_up_of_dispatch_id).toBe(
            left.dispatchId
          )
          h.runtime.getAgentStatusSnapshotFn = null
          vi.mocked(h.runtime.isTerminalRunningAgent).mockResolvedValue(true)
          await report(terminal, moved, 'term_coord')
        }
        const caller = await assignments(terminal, length)
        const trace = traceHistory(h.db)
        await continues(terminal, helper, caller)
        trace.expectIndexedPlans()
        const panes = shape === 'one pane' ? 1 : 2
        // One read per pane however many ancestors share it; each visits only that pane's assignments.
        expect(trace.reads()).toBe(panes)
        expect(trace.visited()).toBeLessThanOrEqual(panes * (length + 2))
        trace.restore()
      }
    }
  )
})

describe('helpers of a worker on the user’s own terminal, after Orca restarts', () => {
  const f = useHelperFollowUpCli({ fileBacked: true })
  const { workerWithHelper } = externalSteps(f)

  it('reads saved history after a restart, with its index rebuilt on an existing database', async () => {
    const { worker, helper } = await workerWithHelper('term_user')
    const reopened = await f.reopenOn(worker, 'term_user')
    f.h.db.db.exec(`DROP INDEX ${HISTORY_INDEX}`)
    f.restart()
    expect(
      f.h.db.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(HISTORY_INDEX)
    ).toEqual({ name: HISTORY_INDEX })
    await f.continues('term_user', helper, reopened)
  })
})
