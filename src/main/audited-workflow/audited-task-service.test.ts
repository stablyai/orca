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

  function useInMemoryRepository(): void {
    setAuditedTaskRepositoryForTests(new AuditedTaskRepository(':memory:'))
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
})
