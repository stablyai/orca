import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { sendMock, getAllWindowsMock, consoleErrorSpy } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getAllWindowsMock: vi.fn(),
  consoleErrorSpy: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: getAllWindowsMock },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import {
  startTriage,
  retryTriage,
  setTriageProviderForTests,
  recoverInterruptedTriageRunsOnStartup
} from './audited-triage-orchestration'
import type { TriageProvider, TriageProviderResult } from './triage-provider'
import type { AuditedTaskState, TriageRunStatus } from '../../shared/audited-workflow-types'

function fakeProvider(result: TriageProviderResult): TriageProvider {
  return { runTriage: async () => result }
}

function fakeWindow() {
  return { isDestroyed: () => false, webContents: { send: sendMock } }
}

function broadcastedProjections(): {
  state: AuditedTaskState
  triageRunStatus: TriageRunStatus | null
}[] {
  return sendMock.mock.calls
    .filter((call) => call[0] === 'auditedWorkflow:taskChanged')
    .map((call) => call[1] as { state: AuditedTaskState; triageRunStatus: TriageRunStatus | null })
}

function broadcastStates(): AuditedTaskState[] {
  return broadcastedProjections().map((p) => p.state)
}

function broadcastTriageRunStatuses(): (TriageRunStatus | null)[] {
  return broadcastedProjections().map((p) => p.triageRunStatus)
}

describe('startTriage', () => {
  beforeEach(() => {
    sendMock.mockReset()
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([fakeWindow()])
    consoleErrorSpy.mockReset()
    vi.spyOn(console, 'error').mockImplementation(consoleErrorSpy)
  })

  afterEach(() => {
    setAuditedTaskRepositoryForTests(undefined)
    setTriageProviderForTests(undefined)
    vi.restoreAllMocks()
  })

  function createSelectedTask() {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)
    return repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Fix the thing',
      spec: { title: 'Fix the thing', description: 'Some details' },
      source: 'custom',
      risk: 'low'
    })
  }

  it('moves selected -> planning when the provider decides plan', async () => {
    const task = createSelectedTask()
    setTriageProviderForTests(
      fakeProvider({
        ok: true,
        output: {
          decision: 'plan',
          risk: 'medium',
          rationale: 'Needs a plan',
          acceptanceCriteria: [{ id: 'ac1', text: 'Works', covered: false }],
          nextStepPrompt: 'Write a plan.'
        }
      })
    )

    const result = await startTriage(task.id)

    expect(result).toEqual({ ok: true })
  })

  it('moves selected -> ready_to_implement when the provider decides direct', async () => {
    const task = createSelectedTask()
    setTriageProviderForTests(
      fakeProvider({
        ok: true,
        output: {
          decision: 'direct',
          risk: 'low',
          rationale: 'Trivial',
          acceptanceCriteria: [{ id: 'ac1', text: 'Works', covered: false }],
          nextStepPrompt: 'Implement it.'
        }
      })
    )

    const result = await startTriage(task.id)

    expect(result).toEqual({ ok: true })
  })

  it('blocks the task with the provider reason code when the provider is unavailable', async () => {
    const task = createSelectedTask()
    setTriageProviderForTests(fakeProvider({ ok: false, reasonCode: 'provider_unavailable' }))

    const result = await startTriage(task.id)

    expect(result).toEqual({ ok: false, reasonCode: 'provider_unavailable' })
  })

  it('blocks the task with output_invalid when the provider returns unparseable output', async () => {
    const task = createSelectedTask()
    setTriageProviderForTests(fakeProvider({ ok: false, reasonCode: 'output_invalid' }))

    const result = await startTriage(task.id)

    expect(result).toEqual({ ok: false, reasonCode: 'output_invalid' })
  })

  it('blocks the task with provider_timeout when the provider times out', async () => {
    const task = createSelectedTask()
    setTriageProviderForTests(fakeProvider({ ok: false, reasonCode: 'provider_timeout' }))

    const result = await startTriage(task.id)

    expect(result).toEqual({ ok: false, reasonCode: 'provider_timeout' })
  })

  it('returns illegal_transition for a task that is not in selected state, and never invokes the provider', async () => {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)
    const task = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Already cancelled',
      spec: { title: 'Already cancelled', description: '' },
      source: 'custom',
      risk: 'low'
    })
    repo.applyTransition({
      taskId: task.id,
      fromState: 'selected',
      toState: 'cancelled',
      actor: 'human',
      eventType: 'task_cancelled'
    })

    let providerCalled = false
    setTriageProviderForTests({
      runTriage: async () => {
        providerCalled = true
        return {
          ok: true,
          output: {
            decision: 'direct',
            risk: 'low',
            rationale: 'x',
            acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
            nextStepPrompt: 'x'
          }
        }
      }
    })

    const result = await startTriage(task.id)

    expect(result).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    expect(providerCalled).toBe(false)
  })

  it('a duplicate concurrent-style start (called twice sequentially) never invokes the provider a second time', async () => {
    const task = createSelectedTask()
    let providerCallCount = 0
    setTriageProviderForTests({
      runTriage: async () => {
        providerCallCount += 1
        return {
          ok: true,
          output: {
            decision: 'direct',
            risk: 'low',
            rationale: 'x',
            acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
            nextStepPrompt: 'x'
          }
        }
      }
    })

    const first = await startTriage(task.id)
    const second = await startTriage(task.id)

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    expect(providerCallCount).toBe(1)
  })

  it('broadcasts a sanitized projection twice: once for the running state, once for the terminal state', async () => {
    const task = createSelectedTask()
    setTriageProviderForTests(
      fakeProvider({
        ok: true,
        output: {
          decision: 'direct',
          risk: 'low',
          rationale: 'x',
          acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
          nextStepPrompt: 'x'
        }
      })
    )

    await startTriage(task.id)

    const states = broadcastStates()
    expect(states).toEqual(['triaging', 'ready_to_implement'])
    // The immediate 'triaging' broadcast must carry a truthful running
    // status, and the terminal broadcast must carry the real final status —
    // never left null/stale on either broadcast.
    expect(broadcastTriageRunStatuses()).toEqual(['running', 'succeeded'])
  })

  it('broadcasts the running state before the provider call resolves — other windows see it without waiting', async () => {
    const task = createSelectedTask()
    let broadcastCountWhenProviderInvoked = -1
    setTriageProviderForTests({
      runTriage: async () => {
        broadcastCountWhenProviderInvoked = sendMock.mock.calls.length
        return {
          ok: true,
          output: {
            decision: 'direct',
            risk: 'low',
            rationale: 'x',
            acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
            nextStepPrompt: 'x'
          }
        }
      }
    })

    await startTriage(task.id)

    expect(broadcastCountWhenProviderInvoked).toBe(1)
    expect(broadcastStates()[0]).toBe('triaging')
  })

  it('broadcasts twice (running + blocked) on a provider failure', async () => {
    const task = createSelectedTask()
    setTriageProviderForTests(fakeProvider({ ok: false, reasonCode: 'provider_timeout' }))

    await startTriage(task.id)

    expect(broadcastStates()).toEqual(['triaging', 'blocked'])
    expect(broadcastTriageRunStatuses()).toEqual(['running', 'blocked'])
  })

  it('when the provider throws after the run has started, finalizes as blocked/provider_error, logs locally, and does not leave a running row', async () => {
    const task = createSelectedTask()
    const sensitiveError = new Error('fetch failed: ECONNRESET at 10.0.0.9:443')
    setTriageProviderForTests({
      runTriage: async () => {
        throw sensitiveError
      }
    })

    const result = await startTriage(task.id)

    expect(result).toEqual({ ok: false, reasonCode: 'provider_error' })
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.any(String), sensitiveError)
    // Only the closed reason code crosses the boundary — never the raw error.
    expect(JSON.stringify(result)).not.toContain('ECONNRESET')
    expect(JSON.stringify(result)).not.toContain('10.0.0.9')
  })

  it('provider throw leaves the task blocked (not stuck triaging) and the run is no longer running', async () => {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)
    const task = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Throws',
      spec: { title: 'Throws', description: '' },
      source: 'custom',
      risk: 'low'
    })
    setTriageProviderForTests({
      runTriage: async () => {
        throw new Error('boom')
      }
    })

    await startTriage(task.id)

    const reloaded = repo.getTask(task.id)
    expect(reloaded?.state).toBe('blocked')
    expect(reloaded?.preBlockState).toBe('triaging')
    expect(reloaded?.blockedReasonCode).toBe('provider_error')
    expect(reloaded?.triageBlockedReasonCode).toBe('provider_error')
    // A fresh Start Triage-equivalent (retry) must be legal — nothing left running.
    expect(repo.retryTriageRun(task.id).ok).toBe(true)
  })
})

describe('retryTriage', () => {
  beforeEach(() => {
    sendMock.mockReset()
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([fakeWindow()])
    consoleErrorSpy.mockReset()
    vi.spyOn(console, 'error').mockImplementation(consoleErrorSpy)
  })

  afterEach(() => {
    setAuditedTaskRepositoryForTests(undefined)
    setTriageProviderForTests(undefined)
    vi.restoreAllMocks()
  })

  function createBlockedTask(
    reasonCode:
      | 'provider_unavailable'
      | 'provider_timeout'
      | 'provider_error'
      | 'output_invalid'
      | 'interrupted' = 'provider_unavailable'
  ) {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)
    const task = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Retry me',
      spec: { title: 'Retry me', description: 'Some details' },
      source: 'custom',
      risk: 'low'
    })
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

  it('successfully retries a retryable blocked triage failure and reaches a terminal decision state', async () => {
    const { task } = createBlockedTask('provider_unavailable')
    setTriageProviderForTests(
      fakeProvider({
        ok: true,
        output: {
          decision: 'plan',
          risk: 'medium',
          rationale: 'Needs a plan now that the key is configured.',
          acceptanceCriteria: [{ id: '1', text: 'Works', covered: false }],
          nextStepPrompt: 'Write a plan.'
        }
      })
    )

    const result = await retryTriage(task.id)

    expect(result).toEqual({ ok: true })
  })

  it('refuses to retry a task that was never blocked', async () => {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)
    const task = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Not blocked',
      spec: { title: 'Not blocked', description: '' },
      source: 'custom',
      risk: 'low'
    })

    const result = await retryTriage(task.id)

    expect(result).toEqual({ ok: false, reasonCode: 'illegal_transition' })
  })

  it('refuses to retry a task blocked for a non-triage reason (unsupported_host)', async () => {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)
    const task = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Blocked for another reason',
      spec: { title: 'Blocked for another reason', description: '' },
      source: 'custom',
      risk: 'low'
    })
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
    let providerCalled = false
    setTriageProviderForTests({
      runTriage: async () => {
        providerCalled = true
        return {
          ok: true,
          output: {
            decision: 'direct',
            risk: 'low',
            rationale: 'x',
            acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
            nextStepPrompt: 'x'
          }
        }
      }
    })

    const result = await retryTriage(task.id)

    expect(result).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    expect(providerCalled).toBe(false)
  })

  it('broadcasts twice on retry (running + terminal)', async () => {
    const { task } = createBlockedTask('interrupted')
    setTriageProviderForTests(
      fakeProvider({
        ok: true,
        output: {
          decision: 'direct',
          risk: 'low',
          rationale: 'x',
          acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
          nextStepPrompt: 'x'
        }
      })
    )

    await retryTriage(task.id)

    expect(broadcastStates()).toEqual(['triaging', 'ready_to_implement'])
    expect(broadcastTriageRunStatuses()).toEqual(['running', 'succeeded'])
  })

  it('a duplicate concurrent-style retry (called twice sequentially) never invokes the provider a second time', async () => {
    const { task } = createBlockedTask('provider_error')
    let providerCallCount = 0
    setTriageProviderForTests({
      runTriage: async () => {
        providerCallCount += 1
        return {
          ok: true,
          output: {
            decision: 'direct',
            risk: 'low',
            rationale: 'x',
            acceptanceCriteria: [{ id: '1', text: 'x', covered: false }],
            nextStepPrompt: 'x'
          }
        }
      }
    })

    const first = await retryTriage(task.id)
    const second = await retryTriage(task.id)

    expect(first).toEqual({ ok: true })
    expect(second).toEqual({ ok: false, reasonCode: 'illegal_transition' })
    expect(providerCallCount).toBe(1)
  })

  it('provider throw during retry finalizes to blocked/provider_error without stranding the run', async () => {
    const { repo, task } = createBlockedTask('output_invalid')
    setTriageProviderForTests({
      runTriage: async () => {
        throw new Error('boom')
      }
    })

    const result = await retryTriage(task.id)

    expect(result).toEqual({ ok: false, reasonCode: 'provider_error' })
    const reloaded = repo.getTask(task.id)
    expect(reloaded?.state).toBe('blocked')
    expect(reloaded?.triageBlockedReasonCode).toBe('provider_error')
    expect(repo.retryTriageRun(task.id).ok).toBe(true)
  })
})

describe('recoverInterruptedTriageRunsOnStartup', () => {
  beforeEach(() => {
    sendMock.mockReset()
    getAllWindowsMock.mockReset()
    getAllWindowsMock.mockReturnValue([fakeWindow()])
  })

  afterEach(() => {
    setAuditedTaskRepositoryForTests(undefined)
  })

  it('broadcasts the recovered blocked projection for a task interrupted mid-triage', () => {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)
    const task = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Interrupted',
      spec: { title: 'Interrupted', description: '' },
      source: 'custom',
      risk: 'low'
    })
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }

    recoverInterruptedTriageRunsOnStartup()

    expect(broadcastStates()).toEqual(['blocked'])
    expect(broadcastTriageRunStatuses()).toEqual(['blocked'])
  })

  it('broadcasts nothing when there is nothing to recover', () => {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)

    recoverInterruptedTriageRunsOnStartup()

    expect(sendMock).not.toHaveBeenCalled()
  })

  it('is safe to call twice in a row (idempotent) — the second call broadcasts nothing new', () => {
    const repo = new AuditedTaskRepository(':memory:')
    setAuditedTaskRepositoryForTests(repo)
    const task = repo.createTask({
      repoId: 'repo1',
      sourceRepoPath: '/repos/repo1',
      baseCommit: 'a'.repeat(40),
      hostId: 'local',
      title: 'Interrupted',
      spec: { title: 'Interrupted', description: '' },
      source: 'custom',
      risk: 'low'
    })
    const started = repo.startTriageRun(task.id)
    if (!started.ok) {
      throw new Error('expected ok')
    }

    recoverInterruptedTriageRunsOnStartup()
    sendMock.mockClear()
    recoverInterruptedTriageRunsOnStartup()

    expect(sendMock).not.toHaveBeenCalled()
  })
})
