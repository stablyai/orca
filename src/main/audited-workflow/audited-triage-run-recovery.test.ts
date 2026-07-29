import { afterEach, describe, expect, it } from 'vitest'
import { AuditedTaskRepository } from './audited-task-repository'

describe('recoverInterruptedTriageRuns', () => {
  let repo: AuditedTaskRepository | undefined

  afterEach(() => {
    repo?.close()
    repo = undefined
  })

  function createSelectedTask() {
    repo = new AuditedTaskRepository(':memory:')
    const task = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Interrupted mid-triage',
      spec: { title: 'Interrupted mid-triage', description: '' },
      source: 'custom',
      risk: 'low'
    })
    return { repo, task }
  }

  it('finalizes an interrupted running run as blocked with the interrupted reason code', () => {
    const { repo, task } = createSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }
    // Simulate a crash: no finalize ever ran, so state=triaging and the run
    // is still 'running'.

    const recovered = repo.recoverInterruptedTriageRuns()

    expect(recovered).toHaveLength(1)
    expect(recovered[0]).toEqual({
      taskId: task.id,
      runId: started.runId,
      task: expect.any(Object)
    })
    const reloaded = repo.getTask(task.id)
    expect(reloaded?.state).toBe('blocked')
    expect(reloaded?.preBlockState).toBe('triaging')
    expect(reloaded?.blockedReasonCode).toBe('interrupted')
    expect(reloaded?.triageBlockedReasonCode).toBe('interrupted')
    // triageRunStatus must be truthfully 'blocked' (the terminal status
    // recovery assigns) — not left 'running' or null after recovery.
    expect(reloaded?.triageRunStatus).toBe('blocked')
  })

  it('records a truthful triaging -> blocked transition with the interrupted reason code', () => {
    const { repo, task } = createSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }

    repo.recoverInterruptedTriageRuns()

    const transitions = repo.listTransitions(task.id)
    const recoveryTransition = transitions.at(-1)
    expect(recoveryTransition?.fromState).toBe('triaging')
    expect(recoveryTransition?.toState).toBe('blocked')
    expect(recoveryTransition?.eventType).toBe('triage_interrupted')
    expect(recoveryTransition?.reasonCode).toBe('interrupted')
    expect(recoveryTransition?.actor).toBe('control')
  })

  it('allows a subsequent Retry after recovery', () => {
    const { repo, task } = createSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }
    repo.recoverInterruptedTriageRuns()

    const retried = repo.retryTriageRun(task.id)

    expect(retried.ok).toBe(true)
    if (!retried.ok) {
      throw new Error('expected ok')
    }
    expect(retried.task.state).toBe('triaging')
  })

  it('is a no-op for a task with no running triage run', () => {
    const { repo, task } = createSelectedTask()
    expect(repo.recoverInterruptedTriageRuns()).toEqual([])
    expect(repo.getTask(task.id)?.state).toBe('selected')
  })

  it('is a no-op for a run already finalized (succeeded)', () => {
    const { repo, task } = createSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }
    repo.finalizeTriageRunSucceeded({
      runId: started.runId,
      taskId: task.id,
      decision: 'direct',
      reasonCode: null,
      rationale: 'x',
      acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
      nextStepPrompt: 'x'
    })

    expect(repo.recoverInterruptedTriageRuns()).toEqual([])
    expect(repo.getTask(task.id)?.state).toBe('ready_to_implement')
  })

  it('is idempotent: calling recovery twice in a row only recovers once and does not double-write', () => {
    const { repo, task } = createSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }

    const first = repo.recoverInterruptedTriageRuns()
    const second = repo.recoverInterruptedTriageRuns()

    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
    // Exactly one recovery transition was recorded, not two.
    const recoveryTransitions = repo
      .listTransitions(task.id)
      .filter((t) => t.eventType === 'triage_interrupted')
    expect(recoveryTransitions).toHaveLength(1)
  })

  it('is CAS-safe: recovering after the task already moved on (e.g. finalized between read and write) is skipped, not overwritten', () => {
    const { repo, task } = createSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }
    // Simulate the run having actually completed successfully in a live
    // process, racing with a recovery pass that read stale 'running' state
    // from a snapshot taken just before that.
    repo.finalizeTriageRunSucceeded({
      runId: started.runId,
      taskId: task.id,
      decision: 'plan',
      reasonCode: null,
      rationale: 'x',
      acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
      nextStepPrompt: 'x'
    })

    const recovered = repo.recoverInterruptedTriageRuns()

    expect(recovered).toEqual([])
    // The real (succeeded) outcome must be preserved, not clobbered by recovery.
    expect(repo.getTask(task.id)?.state).toBe('planning')
  })

  it('recovers multiple independently interrupted tasks in one pass', () => {
    repo = new AuditedTaskRepository(':memory:')
    const taskA = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'A',
      spec: { title: 'A', description: '' },
      source: 'custom',
      risk: 'low'
    })
    const taskB = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'B',
      spec: { title: 'B', description: '' },
      source: 'custom',
      risk: 'low'
    })
    const startedA = repo.startTriageRun(taskA.id)
    const startedB = repo.startTriageRun(taskB.id)
    if (!startedA.ok || !startedB.ok) {
      throw new Error('expected ok')
    }

    const recovered = repo.recoverInterruptedTriageRuns()

    expect(recovered.map((r) => r.taskId).sort()).toEqual([taskA.id, taskB.id].sort())
    expect(repo.getTask(taskA.id)?.state).toBe('blocked')
    expect(repo.getTask(taskB.id)?.state).toBe('blocked')
  })
})
