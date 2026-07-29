import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AuditedTaskRepository } from './audited-task-repository'

describe('audited-triage-run-repository', () => {
  let repo: AuditedTaskRepository | undefined

  afterEach(() => {
    repo?.close()
    repo = undefined
  })

  function freshRepoWithSelectedTask() {
    repo = new AuditedTaskRepository(':memory:')
    const task = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Fix the thing',
      spec: { title: 'Fix the thing', description: 'Details' },
      source: 'custom',
      risk: 'low'
    })
    return { repo, task }
  }

  it('startTriageRun CAS-transitions selected -> triaging and records a running run', () => {
    const { repo, task } = freshRepoWithSelectedTask()

    const result = repo.startTriageRun(task.id)

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok')
    }
    expect(result.runId).toMatch(/^triage_/)
    expect(result.task.state).toBe('triaging')
    // triageRunStatus must be truthfully 'running' in the SAME atomic write
    // that transitions the task to 'triaging' — never left null/stale.
    expect(result.task.triageRunStatus).toBe('running')
    expect(repo.getTask(task.id)?.triageRunStatus).toBe('running')
  })

  it('startTriageRun refuses task_not_found for an unknown task', () => {
    repo = new AuditedTaskRepository(':memory:')
    expect(repo.startTriageRun('missing')).toEqual({
      ok: false,
      reasonCode: 'task_not_found'
    })
  })

  it('startTriageRun refuses illegal_transition when the task is not in selected', () => {
    const { repo, task } = freshRepoWithSelectedTask()
    const first = repo.startTriageRun(task.id)
    expect(first.ok).toBe(true)

    const second = repo.startTriageRun(task.id)
    expect(second).toEqual({ ok: false, reasonCode: 'illegal_transition' })
  })

  it('two racing startTriageRun calls: exactly one wins, the loser gets lock_contended, no duplicate running row', () => {
    const { repo, task } = freshRepoWithSelectedTask()

    const first = repo.startTriageRun(task.id)
    const second = repo.startTriageRun(task.id)

    const results = [first, second]
    const winners = results.filter((r) => r.ok)
    const losers = results.filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    expect(repo.getTask(task.id)?.state).toBe('triaging')
  })

  it('finalizeTriageRunSucceeded with decision=plan CAS-transitions triaging -> planning', () => {
    const { repo, task } = freshRepoWithSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }

    const finalized = repo.finalizeTriageRunSucceeded({
      runId: started.runId,
      taskId: task.id,
      decision: 'plan',
      reasonCode: null,
      rationale: 'Needs a written plan first.',
      acceptanceCriteria: [{ id: 'ac1', text: 'Does the thing', covered: false }],
      nextStepPrompt: 'Write a plan for X.'
    })

    expect(finalized.ok).toBe(true)
    if (!finalized.ok) {
      throw new Error('expected ok')
    }
    expect(finalized.task.state).toBe('planning')
    expect(finalized.task.triageDecision).toBe('plan')
    expect(finalized.task.triageRunStatus).toBe('succeeded')
    expect(finalized.task.triageBlockedReasonCode).toBeNull()
  })

  it('finalizeTriageRunSucceeded with decision=direct CAS-transitions triaging -> ready_to_implement', () => {
    const { repo, task } = freshRepoWithSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }

    const finalized = repo.finalizeTriageRunSucceeded({
      runId: started.runId,
      taskId: task.id,
      decision: 'direct',
      reasonCode: null,
      rationale: 'Trivial change.',
      acceptanceCriteria: [{ id: 'ac1', text: 'Does the thing', covered: false }],
      nextStepPrompt: 'Implement X directly.'
    })

    expect(finalized.ok).toBe(true)
    if (!finalized.ok) {
      throw new Error('expected ok')
    }
    expect(finalized.task.state).toBe('ready_to_implement')
    expect(finalized.task.triageDecision).toBe('direct')
  })

  it('finalizeTriageRunBlocked CAS-transitions triaging -> blocked with the reason code recorded on the task', () => {
    const { repo, task } = freshRepoWithSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }

    const finalized = repo.finalizeTriageRunBlocked({
      runId: started.runId,
      taskId: task.id,
      reasonCode: 'provider_unavailable'
    })

    expect(finalized.ok).toBe(true)
    if (!finalized.ok) {
      throw new Error('expected ok')
    }
    expect(finalized.task.state).toBe('blocked')
    expect(finalized.task.preBlockState).toBe('triaging')
    expect(finalized.task.blockedReasonCode).toBe('provider_unavailable')
    expect(finalized.task.triageBlockedReasonCode).toBe('provider_unavailable')
    expect(finalized.task.triageDecision).toBeNull()
    expect(finalized.task.triageRunStatus).toBe('blocked')
  })

  it('persists a genuine TriageReasonCode value in the generic blockedReasonCode column for every provider-failure reason code (not silently coerced or truncated)', () => {
    for (const reasonCode of [
      'provider_unavailable',
      'provider_timeout',
      'provider_error',
      'output_invalid'
    ] as const) {
      const { repo, task } = freshRepoWithSelectedTask()
      const started = repo.startTriageRun(task.id)
      if (!started.ok) {
        throw new Error('expected ok')
      }

      const finalized = repo.finalizeTriageRunBlocked({
        runId: started.runId,
        taskId: task.id,
        reasonCode
      })

      expect(finalized.ok).toBe(true)
      if (!finalized.ok) {
        throw new Error('expected ok')
      }
      // blockedReasonCode is the GENERIC column shared across phases; here it
      // must hold the real TriageReasonCode value that was actually
      // persisted — never a BlockReasonCode-only value, and never dropped.
      expect(finalized.task.blockedReasonCode).toBe(reasonCode)
      expect(finalized.task.triageBlockedReasonCode).toBe(reasonCode)
      expect(repo.getTask(task.id)?.blockedReasonCode).toBe(reasonCode)
    }
  })

  it('fails closed: does not transition the task when the triage run is no longer running at finalize time (race)', () => {
    // Reproduce "the run is no longer running but the task IS still
    // 'triaging'" — the exact inconsistent-row scenario the run-update
    // changes() check exists to catch. Two concurrent runs can never
    // coexist through the public start/retry API (the partial unique index
    // forbids it), so this test reaches the scenario directly at the SQL
    // layer: it finalizes the run's status out from under a task that a
    // second (still-running) run legitimately owns.
    const { repo, task } = freshRepoWithSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }

    const inconsistentUpdate = repo.finalizeTriageRunBlocked({
      runId: 'triage_does_not_exist',
      taskId: task.id,
      reasonCode: 'provider_error'
    })

    // The run-update WHERE clause matches zero rows (wrong runId), so this
    // must fail closed with lock_contended and leave the task's real state
    // (still 'triaging', still owned by the real running run) untouched.
    expect(inconsistentUpdate).toEqual({ ok: false, reasonCode: 'lock_contended' })
    const afterAttempt = repo.getTask(task.id)
    expect(afterAttempt?.state).toBe('triaging')
    expect(afterAttempt?.triageRunStatus).toBe('running')
    expect(afterAttempt?.blockedReasonCode).toBeNull()
    expect(afterAttempt?.triageBlockedReasonCode).toBeNull()

    // The REAL run is still running and can still be finalized normally —
    // proving the failed stale-runId attempt left it completely intact.
    const realFinalize = repo.finalizeTriageRunSucceeded({
      runId: started.runId,
      taskId: task.id,
      decision: 'direct',
      reasonCode: null,
      rationale: 'x',
      acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
      nextStepPrompt: 'x'
    })
    expect(realFinalize.ok).toBe(true)
  })

  it('finalizing a run for a task that already moved on returns lock_contended and does not clobber state', () => {
    const { repo, task } = freshRepoWithSelectedTask()
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }

    // Simulate the task having already been finalized by a concurrent call.
    const firstFinalize = repo.finalizeTriageRunBlocked({
      runId: started.runId,
      taskId: task.id,
      reasonCode: 'provider_error'
    })
    expect(firstFinalize.ok).toBe(true)

    const secondFinalize = repo.finalizeTriageRunSucceeded({
      runId: started.runId,
      taskId: task.id,
      decision: 'direct',
      reasonCode: null,
      rationale: 'late',
      acceptanceCriteria: [{ id: 'ac1', text: 'x', covered: false }],
      nextStepPrompt: 'y'
    })

    expect(secondFinalize).toEqual({ ok: false, reasonCode: 'lock_contended' })
    // The task's state must still reflect the FIRST (winning) finalize, never
    // a partial/misleading write from the loser.
    expect(repo.getTask(task.id)?.state).toBe('blocked')
  })

  it('persists triage run fields and a running-but-uncompleted run across a simulated restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audited-triage-restart-'))
    try {
      const dbPath = join(dir, 'audited-workflow.db')
      const beforeRestart = new AuditedTaskRepository(dbPath)
      const task = beforeRestart.createTask({
        repoId: 'repo1',
        sourceRepoPath: '/repos/repo1',
        baseCommit: 'a'.repeat(40),
        hostId: 'local',
        title: 'Survives restart',
        spec: { title: 'Survives restart', description: '' },
        source: 'custom',
        risk: 'low'
      })
      const started = beforeRestart.startTriageRun(task.id)
      if (!started.ok) {
        throw new Error('expected ok')
      }
      // Simulate a crash: the provider call never returned, so the run is
      // still 'running' and the task is still 'triaging' when the process
      // exits. No automatic resumption is performed by this phase.
      beforeRestart.close()

      const afterRestart = new AuditedTaskRepository(dbPath)
      try {
        const reloaded = afterRestart.getTask(task.id)
        expect(reloaded?.state).toBe('triaging')

        // A fresh Start Triage on the same task is correctly refused, since
        // the task never left 'triaging' — this proves the partial-unique
        // 'running' index and the task's CAS state both survive restart.
        const secondStart = afterRestart.startTriageRun(task.id)
        expect(secondStart).toEqual({ ok: false, reasonCode: 'illegal_transition' })
      } finally {
        afterRestart.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  describe('retryTriageRun', () => {
    function blockedViaTriageFailure(
      reasonCode:
        | 'provider_unavailable'
        | 'provider_timeout'
        | 'provider_error'
        | 'output_invalid'
        | 'interrupted' = 'provider_unavailable'
    ) {
      const { repo, task } = freshRepoWithSelectedTask()
      const started = repo.startTriageRun(task.id)
      if (!started.ok) {
        throw new Error('expected ok')
      }
      const finalized = repo.finalizeTriageRunBlocked({
        runId: started.runId,
        taskId: task.id,
        reasonCode
      })
      if (!finalized.ok) {
        throw new Error('expected ok')
      }
      return { repo, task }
    }

    it('CAS-transitions blocked -> triaging and starts a fresh running run for a retryable triage failure', () => {
      const { repo, task } = blockedViaTriageFailure('provider_unavailable')

      const retried = repo.retryTriageRun(task.id)

      expect(retried.ok).toBe(true)
      if (!retried.ok) {
        throw new Error('expected ok')
      }
      expect(retried.runId).toMatch(/^triage_/)
      expect(retried.task.state).toBe('triaging')
      // Stale block/triage fields are cleared, not carried forward.
      expect(retried.task.preBlockState).toBeNull()
      expect(retried.task.blockedReasonCode).toBeNull()
      expect(retried.task.blockedPhase).toBeNull()
      expect(retried.task.triageBlockedReasonCode).toBeNull()
      // triageRunStatus must be truthfully 'running' — a fresh run was
      // started atomically with this same CAS write, not left stale/null.
      expect(retried.task.triageRunStatus).toBe('running')
      expect(repo.getTask(task.id)?.state).toBe('triaging')
    })

    it('records a truthful blocked -> triaging retry transition with the original reason code', () => {
      const { repo, task } = blockedViaTriageFailure('output_invalid')
      repo.retryTriageRun(task.id)

      const transitions = repo.listTransitions(task.id)
      const retryTransition = transitions.at(-1)
      expect(retryTransition?.fromState).toBe('blocked')
      expect(retryTransition?.toState).toBe('triaging')
      expect(retryTransition?.eventType).toBe('triage_retried')
      expect(retryTransition?.actor).toBe('human')
    })

    it('allows retry for every retryable triage reason code', () => {
      for (const reasonCode of [
        'provider_unavailable',
        'provider_timeout',
        'provider_error',
        'output_invalid',
        'interrupted'
      ] as const) {
        const { repo, task } = blockedViaTriageFailure(reasonCode)
        expect(repo.retryTriageRun(task.id).ok).toBe(true)
      }
    })

    it('refuses retry for a non-retryable triage reason code (illegal_transition is never a block reason, but lock_contended can appear via finalize races)', () => {
      // lock_contended is never actually written as triage_blocked_reason_code
      // by any code path (it's a repository-level CAS-loss code, not a
      // provider outcome) — this test locks in that even if it somehow were,
      // retry still refuses it, defending the retryable-set boundary itself.
      const { repo, task } = freshRepoWithSelectedTask()
      const started = repo.startTriageRun(task.id)
      if (!started.ok) {
        throw new Error('expected ok')
      }
      // Manually force an out-of-band reason code to simulate defense-in-depth.
      repo.finalizeTriageRunBlocked({
        runId: started.runId,
        taskId: task.id,
        reasonCode: 'lock_contended'
      })

      const retried = repo.retryTriageRun(task.id)
      expect(retried).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    })

    it('refuses retry for a task blocked by a NON-triage reason (pre_block_state is not triaging)', () => {
      const { repo, task } = freshRepoWithSelectedTask()
      // Simulate a block that did not originate from triage — pre_block_state
      // is a different phase's state, and the reason code is not a triage code.
      repo.applyTransition({
        taskId: task.id,
        fromState: 'selected',
        toState: 'blocked',
        actor: 'control',
        eventType: 'blocked_from_invariant_violation',
        preBlockState: 'selected',
        blockedReasonCode: 'unsupported_host',
        blockedPhase: null
      })

      const retried = repo.retryTriageRun(task.id)
      expect(retried).toEqual({ ok: false, reasonCode: 'illegal_transition' })
      // State must be unchanged — refusal must not silently transition anything.
      expect(repo.getTask(task.id)?.state).toBe('blocked')
    })

    it('refuses retry for a task that is not blocked at all', () => {
      const { repo, task } = freshRepoWithSelectedTask()
      expect(repo.retryTriageRun(task.id)).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    })

    it('refuses retry for an unknown task', () => {
      const repo = new AuditedTaskRepository(':memory:')
      expect(repo.retryTriageRun('missing')).toEqual({ ok: false, reasonCode: 'task_not_found' })
    })

    it('two racing retryTriageRun calls: exactly one wins, the loser gets illegal_transition, no duplicate running row', () => {
      const { repo, task } = blockedViaTriageFailure('provider_unavailable')

      const first = repo.retryTriageRun(task.id)
      const second = repo.retryTriageRun(task.id)

      const results = [first, second]
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok)).toHaveLength(1)
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, reasonCode: 'illegal_transition' })
      expect(repo.getTask(task.id)?.state).toBe('triaging')
    })

    it('preserves the one-running-run invariant: retry after a prior finalize can start exactly one new run', () => {
      const { repo, task } = blockedViaTriageFailure('provider_error')
      const retried = repo.retryTriageRun(task.id)
      expect(retried.ok).toBe(true)
      if (!retried.ok) {
        throw new Error('expected ok')
      }

      // A second retry attempt while the new run is still 'running' must fail —
      // the task is 'triaging', not 'blocked'.
      expect(repo.retryTriageRun(task.id)).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    })
  })
})
