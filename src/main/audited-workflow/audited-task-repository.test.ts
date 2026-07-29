import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditedTaskRepository } from './audited-task-repository'

describe('AuditedTaskRepository', () => {
  let repo: AuditedTaskRepository | undefined

  afterEach(() => {
    repo?.close()
    repo = undefined
  })

  function createRepo(): AuditedTaskRepository {
    repo = new AuditedTaskRepository(':memory:')
    return repo
  }

  function createTaskInput(
    overrides: Partial<Parameters<AuditedTaskRepository['createTask']>[0]> = {}
  ) {
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

  it('creates a task in the selected state with a task_created transition', () => {
    const db = createRepo()
    const task = db.createTask(createTaskInput())

    expect(task.state).toBe('selected')
    expect(task.repoId).toBe('repo1')
    expect(task.planRound).toBe(0)
    expect(task.fixRound).toBe(0)
    expect(task.committedSha).toBeNull()

    const transitions = db.listTransitions(task.id)
    expect(transitions).toHaveLength(1)
    expect(transitions[0]).toMatchObject({
      fromState: null,
      toState: 'selected',
      actor: 'human',
      eventType: 'task_created'
    })
  })

  it('round-trips through getTask', () => {
    const db = createRepo()
    const created = db.createTask(createTaskInput({ title: 'Round trip' }))
    const fetched = db.getTask(created.id)
    expect(fetched).toEqual(created)
  })

  it('returns null for an unknown task id', () => {
    const db = createRepo()
    expect(db.getTask('does-not-exist')).toBeNull()
  })

  it('lists tasks filtered by repoId, most recently created first', () => {
    const db = createRepo()
    const a = db.createTask(createTaskInput({ repoId: 'repo1', title: 'A' }))
    const b = db.createTask(createTaskInput({ repoId: 'repo2', title: 'B' }))
    const c = db.createTask(createTaskInput({ repoId: 'repo1', title: 'C' }))

    const repo1Tasks = db.listTasks('repo1')
    expect(repo1Tasks.map((t) => t.id)).toEqual([c.id, a.id])

    const allTasks = db.listTasks()
    expect(allTasks.map((t) => t.id)).toEqual(expect.arrayContaining([a.id, b.id, c.id]))
    expect(allTasks).toHaveLength(3)
  })

  it('applies a transition and records the correct from/to/actor/reason', () => {
    const db = createRepo()
    const task = db.createTask(createTaskInput())

    const result = db.applyTransition({
      taskId: task.id,
      fromState: 'selected',
      toState: 'triaging',
      actor: 'control',
      eventType: 'triage_started'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected transition to succeed')
    }
    expect(result.task.state).toBe('triaging')
    const transitions = db.listTransitions(task.id)
    expect(transitions).toHaveLength(2)
    expect(transitions[1]).toMatchObject({
      fromState: 'selected',
      toState: 'triaging',
      actor: 'control',
      eventType: 'triage_started'
    })
  })

  it('records preBlockState/blockedReasonCode/blockedPhase when blocking', () => {
    const db = createRepo()
    const task = db.createTask(createTaskInput())
    db.applyTransition({
      taskId: task.id,
      fromState: 'selected',
      toState: 'triaging',
      actor: 'control',
      eventType: 'x'
    })

    const result = db.applyTransition({
      taskId: task.id,
      fromState: 'triaging',
      toState: 'blocked',
      actor: 'control',
      eventType: 'triage_blocked',
      reasonCode: 'triage_output_invalid',
      preBlockState: 'triaging',
      blockedReasonCode: 'triage_output_invalid',
      blockedPhase: 'triage'
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected transition to succeed')
    }
    expect(result.task.state).toBe('blocked')
    expect(result.task.preBlockState).toBe('triaging')
    expect(result.task.blockedReasonCode).toBe('triage_output_invalid')
    expect(result.task.blockedPhase).toBe('triage')
  })

  it('returns task_not_found when applying a transition to a nonexistent task', () => {
    const db = createRepo()
    const result = db.applyTransition({
      taskId: 'missing',
      fromState: 'selected',
      toState: 'triaging',
      actor: 'control',
      eventType: 'x'
    })
    expect(result).toEqual({ ok: false, reasonCode: 'task_not_found' })
  })

  it('returns lock_contended and writes no transition when fromState does not match the current row', () => {
    const db = createRepo()
    const task = db.createTask(createTaskInput())

    const result = db.applyTransition({
      taskId: task.id,
      fromState: 'triaging', // wrong — task is actually still 'selected'
      toState: 'planning',
      actor: 'control',
      eventType: 'stale_attempt'
    })

    expect(result).toEqual({ ok: false, reasonCode: 'lock_contended' })
    // No transition row was written for the failed CAS attempt.
    const transitions = db.listTransitions(task.id)
    expect(transitions).toHaveLength(1)
    expect(transitions[0].eventType).toBe('task_created')
    // The task's real state is unchanged.
    expect(db.getTask(task.id)?.state).toBe('selected')
  })

  it('persists transitions in insertion order, queryable by seq', () => {
    const db = createRepo()
    const task = db.createTask(createTaskInput())
    db.applyTransition({
      taskId: task.id,
      fromState: 'selected',
      toState: 'triaging',
      actor: 'control',
      eventType: '1'
    })
    db.applyTransition({
      taskId: task.id,
      fromState: 'triaging',
      toState: 'planning',
      actor: 'triage',
      eventType: '2'
    })

    const transitions = db.listTransitions(task.id)
    expect(transitions.map((t) => t.eventType)).toEqual(['task_created', '1', '2'])
    const seqs = transitions.map((t) => t.seq)
    expect(seqs).toEqual(seqs.toSorted((a, b) => a - b))
  })

  it('survives close/reopen against the same file (schema is durable)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audited-task-repo-'))
    const dbPath = join(dir, 'audited-workflow.db')
    try {
      const first = new AuditedTaskRepository(dbPath)
      const task = first.createTask(createTaskInput({ title: 'Persisted' }))
      first.close()

      const second = new AuditedTaskRepository(dbPath)
      const reloaded = second.getTask(task.id)
      expect(reloaded?.title).toBe('Persisted')
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
