import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { PipelineDb } from './db'
import type { PipelineRunInput } from '../../shared/pipelines-types'

describe('PipelineDb', () => {
  let db: PipelineDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
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
      reviewerAgentId: 'claude',
      mergerAgentId: 'codex',
      verifier: {
        commands: ['pnpm test -- src/main/pipelines/db.test.ts'],
        timeoutSeconds: 120
      },
      executionTargetType: 'ssh',
      executionTargetId: 'ssh_prod'
    }
  }

  function createRun(d = createDb()) {
    return d.createRun(input(), { automationRunId: 'auto_run_1' })
  }

  it('creates the pipeline schema in an empty database', () => {
    const d = createDb()
    const sqlite = (d as unknown as { db: Database.Database }).db
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pipeline_%' ORDER BY name`
      )
      .all() as { name: string }[]

    expect(tables.map((row) => row.name)).toEqual([
      'pipeline_active_run_reservations',
      'pipeline_dynamic_context_results',
      'pipeline_iterations',
      'pipeline_logs',
      'pipeline_recovery_reports',
      'pipeline_runs',
      'pipeline_stages',
      'pipeline_tasks'
    ])
    expect(sqlite.pragma('user_version', { simple: true })).toBe(2)
  })

  it('creates a run and exposes it through list and show paths', () => {
    const d = createDb()
    const run = createRun(d)
    const iteration = d.createIteration({ runId: run.id, iterationNumber: 1 })
    const task = d.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'github_issue',
      sourceId: '4',
      title: 'Add Pipeline DB',
      branch: 'pipeline/s2-add-db',
      blockedBy: ['3'],
      orchestrationTaskId: 'task_abc',
      worktreeId: 'wt_abc',
      terminalIds: ['term_impl'],
      commitShas: ['abc123']
    })
    const stage = d.createStage({
      runId: run.id,
      iterationId: iteration.id,
      taskId: task.id,
      stage: 'implement',
      status: 'running',
      worktreeId: 'wt_abc',
      terminalId: 'term_impl'
    })
    const log = d.appendLog({
      runId: run.id,
      iterationId: iteration.id,
      taskId: task.id,
      stageId: stage.id,
      level: 'info',
      message: 'worker dispatched',
      payload: { orchestrationTaskId: 'task_abc' }
    })

    expect(d.listRuns()).toHaveLength(1)
    expect(d.getRun(run.id)).toMatchObject({
      id: run.id,
      templateId: 'parallel-planner-with-review',
      repoId: 'repo_orca',
      status: 'pending',
      automationRunId: 'auto_run_1'
    })
    expect(d.getRunDetail(run.id)).toMatchObject({
      run: { id: run.id },
      iterations: [{ id: iteration.id, iterationNumber: 1 }],
      tasks: [{ id: task.id, sourceId: '4', blockedBy: ['3'], worktreeId: 'wt_abc' }],
      stages: [{ id: stage.id, status: 'running', terminalId: 'term_impl' }],
      logs: [{ id: log.id, message: 'worker dispatched' }]
    })
  })

  it('updates statuses and writes run transition logs', () => {
    const d = createDb()
    const run = createRun(d)
    const iteration = d.createIteration({ runId: run.id, iterationNumber: 1 })
    const task = d.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'manual',
      sourceId: 'manual-1',
      title: 'Manual task',
      branch: 'pipeline/manual-1'
    })
    const stage = d.createStage({ runId: run.id, iterationId: iteration.id, stage: 'planner' })

    expect(d.updateRunStatus(run.id, 'planning')?.status).toBe('planning')
    expect(d.updateIterationStatus(iteration.id, 'planning')?.status).toBe('planning')
    expect(d.updateTaskStatus(task.id, 'dispatched')?.status).toBe('dispatched')
    expect(
      d.updateStageStatus(stage.id, 'completed', { outputSnapshot: 'ok' })?.completedAt
    ).toEqual(expect.any(String))

    const logs = d.listLogs({ runId: run.id })
    expect(logs.some((entry) => entry.message === 'Pipeline run status changed to planning')).toBe(
      true
    )
  })

  it('cancels an active run and incomplete work records', () => {
    const d = createDb()
    const run = createRun(d)
    const iteration = d.createIteration({ runId: run.id, iterationNumber: 1 })
    const task = d.createTask({
      runId: run.id,
      iterationId: iteration.id,
      sourceType: 'github_issue',
      sourceId: '4',
      title: 'Add Pipeline DB',
      branch: 'pipeline/s2-add-db'
    })
    const stage = d.createStage({
      runId: run.id,
      iterationId: iteration.id,
      taskId: task.id,
      stage: 'implement',
      status: 'running'
    })

    expect(d.cancelRun(run.id).status).toBe('cancelled')
    expect(d.getRun(run.id)?.completedAt).toEqual(expect.any(String))
    expect(d.getIteration(iteration.id)?.status).toBe('cancelled')
    expect(d.getTask(task.id)?.status).toBe('cancelled')
    expect(d.getStage(stage.id)?.status).toBe('cancelled')
  })

  it('persists dynamic context command results', () => {
    const d = createDb()
    const run = createRun(d)
    const stage = d.createStage({ runId: run.id, stage: 'task_source' })

    const result = d.recordDynamicContextResult({
      runId: run.id,
      stageId: stage.id,
      templateId: run.templateId,
      command: 'gh issue list --json number,title',
      cwd: '/repo',
      exitCode: 0,
      timedOut: false,
      stdout: '[{"number":4}]',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false
    })

    expect(d.listDynamicContextResults(run.id)).toMatchObject([{ id: result.id, exitCode: 0 }])
  })

  it('opens an existing database, creates pipeline tables, and preserves data after reopen', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pipeline-db-'))
    const path = join(tempDir, 'pipeline.db')
    const seed = new Database(path)
    seed.exec(`CREATE TABLE existing_data (id TEXT PRIMARY KEY, value TEXT NOT NULL)`)
    seed.prepare(`INSERT INTO existing_data (id, value) VALUES ('old', 'kept')`).run()
    seed.close()

    const first = new PipelineDb(path)
    const run = first.createRun(input())
    first.close()

    const second = new PipelineDb(path)
    db = second
    const sqlite = (second as unknown as { db: Database.Database }).db
    expect(sqlite.prepare(`SELECT value FROM existing_data WHERE id = 'old'`).get()).toEqual({
      value: 'kept'
    })
    expect(second.getRun(run.id)?.id).toBe(run.id)
  })
})
