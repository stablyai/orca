import { afterEach, describe, expect, it } from 'vitest'
import { AuditedTaskRepository } from './audited-task-repository'
import {
  applyDevTransition,
  getTaskProjection,
  listTaskProjections,
  resolveRetryTarget,
  selectTask,
  setAuditedTaskRepositoryForTests
} from './audited-task-service'

describe('audited-task-service', () => {
  afterEach(() => {
    setAuditedTaskRepositoryForTests(undefined)
  })

  function useInMemoryRepository(): AuditedTaskRepository {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)
    return repo
  }

  function baseInput(overrides: Partial<Parameters<typeof selectTask>[0]> = {}) {
    return {
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Fix the thing',
      spec: { title: 'Fix the thing', description: 'Details' },
      source: 'custom' as const,
      risk: 'low' as const,
      ...overrides
    }
  }

  it('selectTask creates a task and getTaskProjection returns its sanitized projection', () => {
    useInMemoryRepository()
    const { taskId } = selectTask(baseInput({ title: 'Sanitized test' }))

    const projection = getTaskProjection(taskId)
    expect(projection).not.toBeNull()
    expect(projection?.title).toBe('Sanitized test')
    expect(projection?.state).toBe('selected')
    expect(projection?.repoId).toBe('repo1')
    expect(projection?.approvalState).toBe('none')
  })

  it('getTaskProjection returns null for an unknown task', () => {
    useInMemoryRepository()
    expect(getTaskProjection('does-not-exist')).toBeNull()
  })

  it('listTaskProjections filters by repoId', () => {
    useInMemoryRepository()
    selectTask(baseInput({ repoId: 'repo1', title: 'A' }))
    selectTask(baseInput({ repoId: 'repo2', title: 'B' }))

    expect(listTaskProjections('repo1')).toHaveLength(1)
    expect(listTaskProjections()).toHaveLength(2)
  })

  it('applyDevTransition drives selected -> triaging -> planning legally', () => {
    useInMemoryRepository()
    const { taskId } = selectTask(baseInput())

    const first = applyDevTransition(taskId, 'triage')
    expect(first).toEqual({ applied: true })
    expect(getTaskProjection(taskId)?.state).toBe('triaging')

    const second = applyDevTransition(taskId, 'triageAutoPlan')
    expect(second).toEqual({ applied: true })
    expect(getTaskProjection(taskId)?.state).toBe('planning')
  })

  it('applyDevTransition refuses an illegal transition and leaves state unchanged', () => {
    useInMemoryRepository()
    const { taskId } = selectTask(baseInput())

    const result = applyDevTransition(taskId, 'implement')
    expect(result).toEqual({ applied: false, reasonCode: 'illegal_transition' })
    expect(getTaskProjection(taskId)?.state).toBe('selected')
  })

  it('applyDevTransition returns task_not_found for an unknown task', () => {
    useInMemoryRepository()
    expect(applyDevTransition('missing', 'triage')).toEqual({
      applied: false,
      reasonCode: 'task_not_found'
    })
  })

  it('blocking records preBlockState and a reason code, retry restores it and clears both', () => {
    useInMemoryRepository()
    const { taskId } = selectTask(baseInput())
    applyDevTransition(taskId, 'triage')

    const blocked = applyDevTransition(taskId, 'triageBlock')
    expect(blocked).toEqual({ applied: true })
    const blockedProjection = getTaskProjection(taskId)
    expect(blockedProjection?.state).toBe('blocked')
    expect(blockedProjection?.blockedReasonCode).toBe('dev_transition_unavailable')
    expect(resolveRetryTarget(taskId)).toBe('triaging')

    const retried = applyDevTransition(taskId, 'retry')
    expect(retried).toEqual({ applied: true })
    const retriedProjection = getTaskProjection(taskId)
    expect(retriedProjection?.state).toBe('triaging')
    expect(retriedProjection?.blockedReasonCode).toBeNull()
    expect(resolveRetryTarget(taskId)).toBeNull()
  })

  it('retry is illegal when the task is not currently blocked', () => {
    useInMemoryRepository()
    const { taskId } = selectTask(baseInput())
    expect(applyDevTransition(taskId, 'retry')).toEqual({
      applied: false,
      reasonCode: 'illegal_transition'
    })
  })

  it('cancel is legal from a non-terminal state and illegal once already terminal', () => {
    useInMemoryRepository()
    const { taskId } = selectTask(baseInput())

    expect(applyDevTransition(taskId, 'cancel')).toEqual({ applied: true })
    expect(getTaskProjection(taskId)?.state).toBe('cancelled')

    expect(applyDevTransition(taskId, 'cancel')).toEqual({
      applied: false,
      reasonCode: 'terminal_state'
    })
  })

  describe('triage reason-code projection truthfulness', () => {
    it('projects triageRunStatus="running" immediately after a triage run starts', () => {
      const repo = useInMemoryRepository()
      const { taskId } = selectTask(baseInput())

      const started = repo.startTriageRun(taskId)
      expect(started.ok).toBe(true)

      const projection = getTaskProjection(taskId)
      expect(projection?.state).toBe('triaging')
      expect(projection?.triageRunStatus).toBe('running')
    })

    it('projects a genuine TriageReasonCode in blockedReasonCode for a provider failure, and it survives to listTaskProjections too', () => {
      const repo = useInMemoryRepository()
      const { taskId } = selectTask(baseInput())
      const started = repo.startTriageRun(taskId)
      if (!started.ok) {
        throw new Error('expected ok')
      }
      const finalized = repo.finalizeTriageRunBlocked({
        runId: started.runId,
        taskId,
        reasonCode: 'provider_timeout'
      })
      expect(finalized.ok).toBe(true)

      const single = getTaskProjection(taskId)
      expect(single?.state).toBe('blocked')
      expect(single?.blockedReasonCode).toBe('provider_timeout')
      expect(single?.triageBlockedReasonCode).toBe('provider_timeout')
      expect(single?.triageRunStatus).toBe('blocked')

      const listed = listTaskProjections().find((t) => t.taskId === taskId)
      expect(listed?.blockedReasonCode).toBe('provider_timeout')
    })

    it('projects the interrupted reason code truthfully after recovery', () => {
      const repo = useInMemoryRepository()
      const { taskId } = selectTask(baseInput())
      const started = repo.startTriageRun(taskId)
      expect(started.ok).toBe(true)

      repo.recoverInterruptedTriageRuns()

      const projection = getTaskProjection(taskId)
      expect(projection?.state).toBe('blocked')
      expect(projection?.blockedReasonCode).toBe('interrupted')
      expect(projection?.triageBlockedReasonCode).toBe('interrupted')
      expect(projection?.triageRunStatus).toBe('blocked')
    })

    it('projects triageRunStatus="succeeded" and the decision after a successful triage finalize', () => {
      const repo = useInMemoryRepository()
      const { taskId } = selectTask(baseInput())
      const started = repo.startTriageRun(taskId)
      if (!started.ok) {
        throw new Error('expected ok')
      }
      repo.finalizeTriageRunSucceeded({
        runId: started.runId,
        taskId,
        decision: 'plan',
        reasonCode: null,
        rationale: 'x',
        acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
        nextStepPrompt: 'x'
      })

      const projection = getTaskProjection(taskId)
      expect(projection?.state).toBe('planning')
      expect(projection?.triageRunStatus).toBe('succeeded')
      expect(projection?.triageDecision).toBe('plan')
      expect(projection?.blockedReasonCode).toBeNull()
    })
  })

  // R13. Phase 6 wires the long-declared acceptanceCriteria field, which was
  // hardcoded to [] since Phase 1. The key property: with no audit yet, criteria
  // are visible but coverage reads as UNKNOWN, not as "nothing covered".
  describe('acceptance-criteria projection', () => {
    function seedTriagedTask(repo: AuditedTaskRepository): string {
      const { taskId } = selectTask(baseInput())
      const started = repo.startTriageRun(taskId)
      if (!started.ok) {
        throw new Error('expected ok')
      }
      repo.finalizeTriageRunSucceeded({
        runId: started.runId,
        taskId,
        decision: 'plan',
        reasonCode: null,
        rationale: 'x',
        acceptanceCriteria: [
          { id: 'ac1', text: 'The parser rejects an unknown verdict.', covered: false },
          { id: 'ac2', text: 'A cancelled run leaves no orphan process.', covered: false }
        ],
        nextStepPrompt: 'x'
      })
      return taskId
    }

    it('projects the triage criteria once triage has succeeded', () => {
      const repo = useInMemoryRepository()
      const taskId = seedTriagedTask(repo)

      const projection = getTaskProjection(taskId)

      expect(projection?.acceptanceCriteria).toEqual([
        { id: 'ac1', text: 'The parser rejects an unknown verdict.', covered: false },
        { id: 'ac2', text: 'A cancelled run leaves no orphan process.', covered: false }
      ])
    })

    // The unknown-vs-uncovered distinction, which `covered` alone cannot express.
    it('reports coverage unavailable when no audit has run', () => {
      const repo = useInMemoryRepository()
      const taskId = seedTriagedTask(repo)

      expect(getTaskProjection(taskId)?.coverageAvailable).toBe(false)
    })

    // Matches pre-Phase-6 behaviour exactly: a task with no succeeded triage run
    // has no criteria to show.
    it('projects no criteria and no coverage before triage', () => {
      useInMemoryRepository()
      const { taskId } = selectTask(baseInput())

      const projection = getTaskProjection(taskId)

      expect(projection?.acceptanceCriteria).toEqual([])
      expect(projection?.coverageAvailable).toBe(false)
    })
  })
})
