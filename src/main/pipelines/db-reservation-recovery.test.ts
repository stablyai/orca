import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../sqlite/sync-database'
import { PipelineDb } from './db'
import type { PipelineRunInput } from '../../shared/pipelines-types'

describe('PipelineDb reservation and recovery state', () => {
  let db: PipelineDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): PipelineDb {
    db = new PipelineDb(':memory:')
    return db
  }

  function input(): PipelineRunInput {
    return {
      templateId: 'parallel-planner-with-review',
      repoId: 'repo_orca',
      sourceBranch: 'main',
      targetBranch: 'pipeline-output',
      taskSource: {
        type: 'github_issues',
        provider: 'github',
        owner: 'Nikolatesla-lj',
        repo: 'orca',
        prdIssueNumber: 13,
        pipelinePrdLabel: 'pipeline:prd-13',
        state: 'open'
      },
      maxConcurrent: 2,
      maxIterations: 3,
      plannerAgentId: 'codex',
      implementerAgentId: 'codex',
      mergerAgentId: 'codex',
      executionTargetType: 'local'
    }
  }

  const prdWorkSet = {
    repoId: 'repo_orca',
    providerOwner: 'Nikolatesla-lj',
    providerRepo: 'orca',
    prdIssueNumber: 13,
    pipelinePrdLabel: 'pipeline:prd-13'
  }

  it('creates frozen v1 DB tables and columns for reservations and recovery', () => {
    const d = createDb()
    const sqlite = (d as unknown as { db: Database.Database }).db
    const tableNames = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pipeline_%' ORDER BY name`
      )
      .all()
      .map((row) => (row as { name: string }).name)

    expect(tableNames).toEqual([
      'pipeline_active_run_reservations',
      'pipeline_dynamic_context_results',
      'pipeline_iterations',
      'pipeline_logs',
      'pipeline_recovery_reports',
      'pipeline_runs',
      'pipeline_stages',
      'pipeline_tasks'
    ])

    const runColumns = (sqlite.pragma('table_info(pipeline_runs)') as { name: string }[]).map(
      (row) => (row as { name: string }).name
    )
    expect(runColumns).toEqual(
      expect.arrayContaining(['status_reason', 'replaces_run_id', 'recovery_report_id'])
    )

    const taskColumns = (sqlite.pragma('table_info(pipeline_tasks)') as { name: string }[]).map(
      (row) => (row as { name: string }).name
    )
    expect(taskColumns).toContain('issue_closure_json')
  })

  it('keeps Pipeline terminal statuses immutable, including interrupted runs', () => {
    const d = createDb()
    const run = d.createRun(input())
    const iteration = d.createIteration({ runId: run.id, iterationNumber: 1 })
    const task = d.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'github_issue',
      sourceId: '15',
      title: 'Align Pipeline DB',
      branch: 'pipeline/issue-15'
    })
    const stage = d.createStage({
      runId: run.id,
      iterationId: iteration.id,
      taskId: task.id,
      stage: 'implement',
      status: 'running'
    })

    expect(d.updateRunStatus(run.id, 'interrupted')?.status).toBe('interrupted')
    expect(d.updateRunStatus(run.id, 'completed')?.status).toBe('interrupted')
    expect(d.updateIterationStatus(iteration.id, 'interrupted')?.status).toBe('interrupted')
    expect(d.updateIterationStatus(iteration.id, 'completed')?.status).toBe('interrupted')
    expect(d.updateTaskStatus(task.id, 'interrupted')?.status).toBe('interrupted')
    expect(d.updateTaskStatus(task.id, 'verified')?.status).toBe('interrupted')
    expect(d.updateStageStatus(stage.id, 'interrupted')?.status).toBe('interrupted')
    expect(d.updateStageStatus(stage.id, 'completed')?.status).toBe('interrupted')
  })

  it('enforces one active reservation per PRD work set and releases it explicitly', () => {
    const d = createDb()
    const run = d.createRun(input())
    const reservation = d.createActiveRunReservation({
      runId: run.id,
      ...prdWorkSet
    })

    expect(d.getActiveRunReservation(prdWorkSet)).toMatchObject({
      id: reservation.id,
      runId: run.id,
      status: 'active',
      executionTargetType: 'local',
      prdIssueNumber: 13,
      pipelinePrdLabel: 'pipeline:prd-13'
    })
    expect(() =>
      d.createActiveRunReservation({
        runId: d.createRun({ ...input(), executionTargetType: 'ssh', executionTargetId: 'ssh_1' })
          .id,
        ...prdWorkSet
      })
    ).toThrow(/active Pipeline run reservation/i)

    expect(d.releaseActiveRunReservation(reservation.id, 'completed')).toMatchObject({
      id: reservation.id,
      status: 'released',
      releaseReason: 'completed'
    })
    expect(d.getActiveRunReservation(prdWorkSet)).toBeUndefined()
  })

  it('stores recovery reports, selects the latest pending report, and preserves older reports', () => {
    const d = createDb()
    const oldRun = d.createRun(input())
    const newRun = d.createRun(input())
    const older = d.createRecoveryReport({
      interruptedRunId: oldRun.id,
      ...prdWorkSet,
      summary: {
        completedTaskIssueNumbers: [14],
        openReadyTaskIssueNumbers: [15],
        preservedWorktreeIds: ['wt_old'],
        dirtyWorktreeIds: [],
        liveTerminalIds: [],
        missingTerminalIds: ['term_old']
      }
    })
    const latest = d.createRecoveryReport({
      interruptedRunId: newRun.id,
      ...prdWorkSet,
      summary: {
        completedTaskIssueNumbers: [14],
        openReadyTaskIssueNumbers: [15, 16],
        preservedWorktreeIds: ['wt_new'],
        dirtyWorktreeIds: ['wt_dirty'],
        liveTerminalIds: [],
        missingTerminalIds: ['term_new']
      }
    })

    expect(d.getLatestPendingRecoveryReport(prdWorkSet)?.id).toBe(latest.id)
    expect(d.acknowledgeRecoveryReport(latest.id)).toMatchObject({
      id: latest.id,
      status: 'acknowledged',
      acknowledgedAt: expect.any(String)
    })
    expect(d.getRecoveryReport(older.id)?.status).toBe('pending_ack')
    expect(d.getLatestPendingRecoveryReport(prdWorkSet)?.id).toBe(older.id)
  })

  it('records replacement lineage without rewriting the interrupted run', () => {
    const d = createDb()
    const interrupted = d.createRun(input())
    d.updateRunStatus(interrupted.id, 'interrupted')
    const report = d.acknowledgeRecoveryReport(
      d.createRecoveryReport({
        interruptedRunId: interrupted.id,
        ...prdWorkSet,
        summary: {
          completedTaskIssueNumbers: [],
          openReadyTaskIssueNumbers: [15],
          preservedWorktreeIds: ['wt_1'],
          dirtyWorktreeIds: ['wt_1'],
          liveTerminalIds: [],
          missingTerminalIds: ['term_1']
        }
      }).id
    )!

    const replacement = d.createRun(input(), {
      replacesRunId: interrupted.id,
      recoveryReportId: report.id
    })

    expect(d.getRun(replacement.id)).toMatchObject({
      id: replacement.id,
      replacesRunId: interrupted.id,
      recoveryReportId: report.id
    })
    expect(d.getRecoveryReport(report.id)).toMatchObject({
      id: report.id,
      replacementRunId: replacement.id
    })
    expect(d.getRun(interrupted.id)?.status).toBe('interrupted')
  })
})
