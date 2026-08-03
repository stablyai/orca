// Phase 4 sanitization. Runtime key inspection over the ACTUAL projection
// object, not just the compiled type — a bug could still attach an extra field.
// Agent output is the highest-risk carrier of secrets and absolute paths, so not
// even a path to the log directory may cross.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { getTaskProjection, setAuditedTaskRepositoryForTests } from './audited-task-service'
import { finalizeExecutionRun } from './audited-execution-run-repository'
import { AUDITED_PROJECTION_FORBIDDEN_KEYS } from '../../shared/audited-workflow-projection'
import { seedTriagedTask, seedTriageRun, startRun } from './audited-execution-test-fixtures'

let repository: AuditedTaskRepository

function makeTask(): string {
  return repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: '/tmp/secret-repo-path',
    baseCommit: 'a'.repeat(40),
    hostId: 'local',
    title: 'Do the thing',
    spec: { title: 'Do the thing', description: '' },
    source: 'custom',
    risk: 'low'
  }).id
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
})

afterEach(() => {
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
})

describe('execution fields on the projection', () => {
  it('exposes exactly three execution facts', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    startRun(repository, taskId, 'plan')

    const projection = getTaskProjection(taskId)
    expect(projection?.executionRunStatus).toBe('running')
    expect(projection?.executionReasonCode).toBeNull()
    expect(projection?.executionOutputTruncated).toBe(false)
  })

  it('surfaces the terminal reason and the truncation flag', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'plan')
    const runId = startRun(repository, taskId, 'plan')
    finalizeExecutionRun(
      repository.getDatabase(),
      {
        runId,
        taskId,
        status: 'failed',
        reasonCode: 'empty_output',
        toState: 'blocked',
        blockedReasonCode: 'plan_output_empty',
        preBlockState: 'planning',
        blockedPhase: 'execution',
        eventType: 'execution_blocked',
        counters: { stdoutBytes: 999, stderrBytes: 5, outputTruncated: true, exitCode: 0 }
      },
      200
    )

    const projection = getTaskProjection(taskId)
    expect(projection?.executionRunStatus).toBe('failed')
    expect(projection?.executionReasonCode).toBe('empty_output')
    expect(projection?.executionOutputTruncated).toBe(true)
  })

  it('is null for a task that never ran', () => {
    const taskId = makeTask()
    const projection = getTaskProjection(taskId)
    expect(projection?.executionRunStatus).toBeNull()
    expect(projection?.executionReasonCode).toBeNull()
    expect(projection?.executionOutputTruncated).toBe(false)
  })
})

describe('nothing sensitive crosses the boundary', () => {
  it('carries no forbidden key at runtime', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    seedTriageRun(repository.getDatabase(), taskId, 'a secret prompt')
    startRun(repository, taskId, 'direct')

    const projection = getTaskProjection(taskId) as unknown as Record<string, unknown>
    for (const key of AUDITED_PROJECTION_FORBIDDEN_KEYS) {
      expect(Object.hasOwn(projection, key), `projection leaked ${key}`).toBe(false)
    }
  })

  it('carries no byte counters, log path, or prompt text', () => {
    const taskId = makeTask()
    seedTriagedTask(repository, taskId, 'direct')
    seedTriageRun(repository.getDatabase(), taskId, 'a secret prompt')
    startRun(repository, taskId, 'direct')

    const serialized = JSON.stringify(getTaskProjection(taskId))
    expect(serialized).not.toContain('a secret prompt')
    expect(serialized).not.toContain('/tmp/secret-repo-path')
    expect(serialized).not.toContain('stdoutBytes')
    expect(serialized).not.toContain('stderrBytes')
    expect(serialized).not.toContain('audited-workflow/runs')
  })

  it('lists the Phase 4 internals in the denylist', () => {
    for (const key of [
      'executionLogPath',
      'stdoutLog',
      'stderrLog',
      'argv',
      'settingsPath',
      'pid',
      'model',
      'nextStepPrompt'
    ]) {
      expect(AUDITED_PROJECTION_FORBIDDEN_KEYS).toContain(key)
    }
  })
})
