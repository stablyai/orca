// Restart/recovery test for Phase 1 (plan §14, "Restart/recovery"). Proves
// that a task's state survives a process restart (simulated by closing and
// reopening the repository against the same on-disk file) and that mere
// reads never mutate anything — Phase 1 has no reconciliation service yet
// (that ships in Phase 2), so this test's scope is intentionally narrow:
// durability across restart, not drift classification.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditedTaskRepository } from './audited-task-repository'

describe('audited workflow restart recovery', () => {
  let dir: string | undefined

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
      dir = undefined
    }
  })

  it('reloads a task in its exact persisted state after a simulated restart', () => {
    dir = mkdtempSync(join(tmpdir(), 'audited-workflow-restart-'))
    const dbPath = join(dir, 'audited-workflow.db')

    // "Before restart": create a task and drive it partway through the state
    // machine, as Phase 1's dev-transition control would.
    const beforeRestart = new AuditedTaskRepository(dbPath)
    const created = beforeRestart.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Survives restart',
      spec: { title: 'Survives restart', description: '' },
      source: 'custom',
      risk: 'medium'
    })
    beforeRestart.applyTransition({
      taskId: created.id,
      fromState: 'selected',
      toState: 'triaging',
      actor: 'control',
      eventType: 'triage_started'
    })
    beforeRestart.applyTransition({
      taskId: created.id,
      fromState: 'triaging',
      toState: 'blocked',
      actor: 'control',
      eventType: 'triage_blocked',
      reasonCode: 'triage_output_invalid',
      preBlockState: 'triaging',
      blockedReasonCode: 'triage_output_invalid',
      blockedPhase: 'triage'
    })
    const beforeState = beforeRestart.getTask(created.id)
    const beforeTransitions = beforeRestart.listTransitions(created.id)
    // Why: close simulates process exit — nothing further may be written
    // through this handle.
    beforeRestart.close()

    // "After restart": open a fresh repository instance against the same file,
    // exactly as getAuditedTaskRepository()'s lazy singleton would after relaunch.
    const afterRestart = new AuditedTaskRepository(dbPath)
    try {
      const afterState = afterRestart.getTask(created.id)
      const afterTransitions = afterRestart.listTransitions(created.id)

      expect(afterState).toEqual(beforeState)
      expect(afterState?.state).toBe('blocked')
      expect(afterState?.preBlockState).toBe('triaging')
      expect(afterState?.blockedReasonCode).toBe('triage_output_invalid')
      expect(afterTransitions).toEqual(beforeTransitions)
      expect(afterTransitions).toHaveLength(3) // task_created, triage_started, triage_blocked

      // Reading must never mutate — re-reading twice yields byte-identical
      // results and does not advance state or append a transition.
      const rereadState = afterRestart.getTask(created.id)
      const rereadTransitions = afterRestart.listTransitions(created.id)
      expect(rereadState).toEqual(afterState)
      expect(rereadTransitions).toEqual(afterTransitions)
    } finally {
      afterRestart.close()
    }
  })

  it('lists tasks correctly across a restart, including multiple tasks and repos', () => {
    dir = mkdtempSync(join(tmpdir(), 'audited-workflow-restart-list-'))
    const dbPath = join(dir, 'audited-workflow.db')

    const beforeRestart = new AuditedTaskRepository(dbPath)
    const taskA = beforeRestart.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'A',
      spec: { title: 'A', description: '' },
      source: 'custom',
      risk: 'low'
    })
    const taskB = beforeRestart.createTask({
      repoId: 'repo2',
      sourceRepoPath: '/repos/repo2',
      baseCommit: 'b'.repeat(40),
      hostId: 'local',
      title: 'B',
      spec: { title: 'B', description: '' },
      source: 'custom',
      risk: 'high'
    })
    beforeRestart.close()

    const afterRestart = new AuditedTaskRepository(dbPath)
    try {
      const all = afterRestart.listTasks()
      expect(all.map((t) => t.id).sort()).toEqual([taskA.id, taskB.id].sort())

      const repo1Only = afterRestart.listTasks('repo1')
      expect(repo1Only.map((t) => t.id)).toEqual([taskA.id])
    } finally {
      afterRestart.close()
    }
  })
})
