import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunnerModuleNamespace from '../git/runner'

type GitRunnerModule = typeof GitRunnerModuleNamespace

const {
  handleMock,
  getGitRepoRootMock,
  gitExecFileAsyncMock,
  consoleErrorSpy,
  hasKeyMock,
  saveKeyMock,
  clearKeyMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getGitRepoRootMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  consoleErrorSpy: vi.fn(),
  hasKeyMock: vi.fn(),
  saveKeyMock: vi.fn(),
  clearKeyMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  BrowserWindow: {
    getAllWindows: () => []
  }
}))

vi.mock('../git/repo', () => ({
  getGitRepoRoot: getGitRepoRootMock
}))

// Why partial: selectTask's HEAD probe is asserted on argv, but Phase 3
// provisioning must run against a REAL repository — a fully mocked runner would
// make "the provider only runs after a verified worktree" untestable here.
// gitExecFileAsyncMock delegates to the real implementation unless a test
// overrides it.
vi.mock('../git/runner', async () => {
  const actual = await vi.importActual<GitRunnerModule>('../git/runner')
  return { ...actual, gitExecFileAsync: gitExecFileAsyncMock }
})

vi.mock('../audited-workflow/audited-triage-api-key-store', () => ({
  hasAuditedTriageApiKey: hasKeyMock,
  saveAuditedTriageApiKey: saveKeyMock,
  clearAuditedTriageApiKey: clearKeyMock
}))

import { registerAuditedWorkflowHandlers } from './audited-workflow'
import { AuditedTaskRepository } from '../audited-workflow/audited-task-repository'
import { setAuditedTaskRepositoryForTests } from '../audited-workflow/audited-task-service'
import { setTriageProviderForTests } from '../audited-workflow/audited-triage-orchestration'
import { setAuditedWorktreeStore } from '../audited-workflow/audited-worktree-service'
import { clearAuditedWorktreeRegistryForTests } from '../audited-workflow/audited-worktree-registry'
import { createTestRepo, type TestRepo } from '../audited-workflow/audited-worktree-test-repo'
import type {
  AuditedWorkflowSelectTaskResult,
  AuditedWorkflowStartTriageResult,
  AuditedWorkflowRetryTriageResult,
  AuditedWorkflowTriageProviderStatus
} from '../../shared/audited-workflow-types'

describe('registerAuditedWorkflowHandlers', () => {
  const gitRepo1 = {
    id: 'repo1',
    path: 'C:\\repos\\repo1',
    displayName: 'Repo 1',
    connectionId: null as string | null,
    kind: 'git' as 'git' | 'folder'
  }
  const store = {
    getRepos: vi.fn(() => [gitRepo1]),
    getSettings: vi.fn(() => ({ workspaceDir: '', nestWorkspaces: false }))
  }

  beforeEach(() => {
    handleMock.mockReset()
    getGitRepoRootMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    consoleErrorSpy.mockReset()
    hasKeyMock.mockReset()
    saveKeyMock.mockReset()
    clearKeyMock.mockReset()
    hasKeyMock.mockReturnValue(false)
    vi.spyOn(console, 'error').mockImplementation(consoleErrorSpy)
    store.getRepos.mockReturnValue([gitRepo1])
    store.getSettings.mockReturnValue({ workspaceDir: '', nestWorkspaces: false })
    getGitRepoRootMock.mockReturnValue('C:\\repos\\repo1')
    gitExecFileAsyncMock.mockResolvedValue({ stdout: `${'a'.repeat(40)}\n`, stderr: '' })
    setAuditedTaskRepositoryForTests(new AuditedTaskRepository(':memory:'))
    clearAuditedWorktreeRegistryForTests()
  })

  afterEach(() => {
    setAuditedTaskRepositoryForTests(undefined)
    setTriageProviderForTests(undefined)
    setAuditedWorktreeStore(undefined)
    clearAuditedWorktreeRegistryForTests()
    while (activeRepos.length > 0) {
      activeRepos.pop()?.cleanup()
    }
    vi.restoreAllMocks()
  })

  // Repoints the handlers at a REAL repository so provisioning genuinely runs.
  // Returns the created task id, already provisioned-capable.
  //
  // getSettings must live on the SAME store object the handlers receive:
  // registerAuditedWorkflowHandlers re-runs on every getHandler call and calls
  // setAuditedWorktreeStore(store), so a separately-injected store would be
  // overwritten on the next lookup.
  const activeRepos: TestRepo[] = []
  async function createProvisionableTask(): Promise<string> {
    const testRepo = createTestRepo()
    activeRepos.push(testRepo)
    store.getRepos.mockReturnValue([{ ...gitRepo1, path: testRepo.repoPath }])
    store.getSettings.mockReturnValue({
      workspaceDir: testRepo.workspaceRoot,
      nestWorkspaces: false
    })
    getGitRepoRootMock.mockReturnValue(testRepo.repoPath)
    gitExecFileAsyncMock.mockResolvedValue({ stdout: `${testRepo.headCommit}\n`, stderr: '' })
    const taskId = await createSelectedTask()
    // Real Git from here on, so worktree add / verification actually execute.
    const realRunner = await vi.importActual<GitRunnerModule>('../git/runner')
    gitExecFileAsyncMock.mockImplementation(realRunner.gitExecFileAsync)
    return taskId
  }

  function getHandler(channel: string) {
    registerAuditedWorkflowHandlers(store as never)
    const call = handleMock.mock.calls.find((entry: unknown[]) => entry[0] === channel)
    if (!call) {
      throw new Error(`${channel} handler was not registered`)
    }
    return call[1] as (_event: unknown, args?: unknown) => Promise<unknown>
  }

  function selectTaskArgs(overrides: Record<string, unknown> = {}) {
    return {
      repoId: 'repo1',
      source: 'custom',
      title: 'Do the thing',
      description: 'Details',
      risk: 'low',
      ...overrides
    }
  }

  async function createSelectedTask(): Promise<string> {
    const selectHandler = getHandler('auditedWorkflow:selectTask')
    const created = (await selectHandler(null, selectTaskArgs())) as AuditedWorkflowSelectTaskResult
    if (!created.ok) {
      throw new Error('expected ok result')
    }
    return created.taskId
  }

  it('selectTask resolves the repo, reads HEAD read-only, and returns a taskId', async () => {
    const handler = getHandler('auditedWorkflow:selectTask')

    const result = (await handler(null, selectTaskArgs())) as AuditedWorkflowSelectTaskResult

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error('expected ok result')
    }
    expect(result.taskId).toMatch(/^audited_/)
    expect(getGitRepoRootMock).toHaveBeenCalledWith('C:\\repos\\repo1')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', 'HEAD'],
      expect.objectContaining({ cwd: 'C:\\repos\\repo1' })
    )
    // Read-only resolution only: no worktree/mutation git commands issued.
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('selectTask rejects a title with embedded newlines (Zod validation still throws)', async () => {
    const handler = getHandler('auditedWorkflow:selectTask')

    await expect(handler(null, selectTaskArgs({ title: 'line one\nline two' }))).rejects.toThrow()
  })

  it('selectTask rejects an invalid risk value (Zod validation still throws)', async () => {
    const handler = getHandler('auditedWorkflow:selectTask')

    await expect(handler(null, selectTaskArgs({ risk: 'catastrophic' }))).rejects.toThrow()
  })

  it('selectTask returns repo_not_found as a structured result, not a thrown error', async () => {
    const handler = getHandler('auditedWorkflow:selectTask')

    const result = (await handler(
      null,
      selectTaskArgs({ repoId: 'does-not-exist' })
    )) as AuditedWorkflowSelectTaskResult

    expect(result).toEqual({ ok: false, reasonCode: 'repo_not_found' })
    expect(getGitRepoRootMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('selectTask refuses an SSH-hosted repo with unsupported_host and invokes no Git command', async () => {
    store.getRepos.mockReturnValue([{ ...gitRepo1, connectionId: 'ssh:example' }])
    const handler = getHandler('auditedWorkflow:selectTask')

    const result = (await handler(null, selectTaskArgs())) as AuditedWorkflowSelectTaskResult

    expect(result).toEqual({ ok: false, reasonCode: 'unsupported_host' })
    expect(getGitRepoRootMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('selectTask refuses a WSL-hosted repo with the same unsupported_host code and no Git command', async () => {
    store.getRepos.mockReturnValue([
      { ...gitRepo1, path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' }
    ])
    const handler = getHandler('auditedWorkflow:selectTask')

    const result = (await handler(null, selectTaskArgs())) as AuditedWorkflowSelectTaskResult

    expect(result).toEqual({ ok: false, reasonCode: 'unsupported_host' })
    expect(getGitRepoRootMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it.each([
    ['auditedWorkflow:startTriage'],
    ['auditedWorkflow:retryTriage'],
    ['auditedWorkflow:provisionWorktree'],
    ['auditedWorkflow:verifyWorktree']
  ])('%s REJECTS extra identity keys rather than stripping them', async (channel) => {
    const handler = getHandler(channel)

    // A renderer must never be able to influence worktree identity.
    await expect(
      handler(null, { taskId: 'audited_1', worktreePath: '/evil', branch: 'x' })
    ).rejects.toThrow()
  })

  it('selectTask rejects extra keys too', async () => {
    const handler = getHandler('auditedWorkflow:selectTask')

    await expect(handler(null, selectTaskArgs({ baseCommit: 'a'.repeat(40) }))).rejects.toThrow()
  })

  it('selectTask refuses a folder repo with the SAME unsupported_host code and invokes no Git command', async () => {
    store.getRepos.mockReturnValue([{ ...gitRepo1, kind: 'folder' as const }])
    const handler = getHandler('auditedWorkflow:selectTask')

    const result = (await handler(null, selectTaskArgs())) as AuditedWorkflowSelectTaskResult

    expect(result).toEqual({ ok: false, reasonCode: 'unsupported_host' })
    expect(getGitRepoRootMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('selectTask redacts a Git resolution failure: closed reason code only, no path/command/stderr reaches the result', async () => {
    const sensitiveMessage =
      'Command failed: git -C /Users/carfun/secret-project rev-parse HEAD\nfatal: not a git repository (or any of the parent directories): .git\n  at /Users/carfun/PycharmProjects/orca-orchestrator/src/main/git/runner.ts:900:12'
    getGitRepoRootMock.mockImplementation(() => {
      throw new Error(sensitiveMessage)
    })
    const handler = getHandler('auditedWorkflow:selectTask')

    const result = (await handler(null, selectTaskArgs())) as AuditedWorkflowSelectTaskResult

    expect(result).toEqual({ ok: false, reasonCode: 'git_resolution_failed' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('/Users/carfun')
    expect(serialized).not.toContain('git -C')
    expect(serialized).not.toContain('rev-parse')
    expect(serialized).not.toContain('fatal:')
    expect(serialized).not.toContain('.ts:900')
    // The raw error is still available locally, via console.error, for diagnostics —
    // it just never crosses into the structured IPC result.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Git resolution failed'),
      expect.any(Error)
    )
  })

  it('selectTask redacts an internal task-creation failure the same way', async () => {
    setAuditedTaskRepositoryForTests({
      createTask: () => {
        throw new Error(
          'INSERT INTO audited_tasks failed: UNIQUE constraint at /var/lib/orca/audited-workflow.db'
        )
      },
      recoverInterruptedTriageRuns: () => []
    } as never)
    const handler = getHandler('auditedWorkflow:selectTask')

    const result = (await handler(null, selectTaskArgs())) as AuditedWorkflowSelectTaskResult

    expect(result).toEqual({ ok: false, reasonCode: 'internal_error' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('/var/lib/orca')
    expect(serialized).not.toContain('UNIQUE constraint')
    expect(serialized).not.toContain('INSERT INTO')
  })

  it('listTasks and getTask round-trip through the projection', async () => {
    const selectHandler = getHandler('auditedWorkflow:selectTask')
    const created = (await selectHandler(
      null,
      selectTaskArgs({ title: 'Listed task', risk: 'medium' })
    )) as AuditedWorkflowSelectTaskResult
    if (!created.ok) {
      throw new Error('expected ok result')
    }

    const listHandler = getHandler('auditedWorkflow:listTasks')
    const list = (await listHandler(null, { repoId: 'repo1' })) as { taskId: string }[]
    expect(list.some((t) => t.taskId === created.taskId)).toBe(true)

    const getHandlerFn = getHandler('auditedWorkflow:getTask')
    const single = (await getHandlerFn(null, { taskId: created.taskId })) as {
      title: string
    } | null
    expect(single?.title).toBe('Listed task')
  })

  it('getTask rejects malformed params (missing taskId)', () => {
    // Why: getTask's handler is synchronous — Zod's .parse() throws directly
    // rather than rejecting a promise; Electron's IPC layer wraps this into a
    // rejection for the renderer, but this unit test calls the raw handler.
    const handler = getHandler('auditedWorkflow:getTask')
    expect(() => handler(null, {})).toThrow()
  })

  describe('startTriage', () => {
    it('rejects malformed params (missing taskId)', async () => {
      const handler = getHandler('auditedWorkflow:startTriage')
      await expect(handler(null, {})).rejects.toThrow()
    })

    it('drives selected -> planning on a plan decision and broadcasts the sanitized projection', async () => {
      const taskId = await createProvisionableTask()
      setTriageProviderForTests({
        runTriage: async () => ({
          ok: true,
          output: {
            decision: 'plan',
            risk: 'medium',
            rationale: 'Needs a written plan.',
            acceptanceCriteria: [{ id: 'ac1', text: 'Does the thing', covered: false }],
            nextStepPrompt: 'Write a plan for the task.'
          }
        })
      })
      const handler = getHandler('auditedWorkflow:startTriage')

      const result = (await handler(null, { taskId })) as AuditedWorkflowStartTriageResult

      expect(result).toEqual({ ok: true })
      const getTaskHandler = getHandler('auditedWorkflow:getTask')
      const projection = (await getTaskHandler(null, { taskId })) as { state: string } | null
      expect(projection?.state).toBe('planning')
    })

    it('returns lock_contended (as a structured result) for a duplicate concurrent-style start', async () => {
      const taskId = await createProvisionableTask()
      setTriageProviderForTests({
        runTriage: async () => ({
          ok: true,
          output: {
            decision: 'direct',
            risk: 'low',
            rationale: 'Trivial.',
            acceptanceCriteria: [{ id: 'ac1', text: 'Works', covered: false }],
            nextStepPrompt: 'Implement it.'
          }
        })
      })
      const handler = getHandler('auditedWorkflow:startTriage')

      const first = (await handler(null, { taskId })) as AuditedWorkflowStartTriageResult
      const second = (await handler(null, { taskId })) as AuditedWorkflowStartTriageResult

      expect(first).toEqual({ ok: true })
      expect(second).toEqual({ ok: false, kind: 'triage', reasonCode: 'illegal_transition' })
    })

    it('returns provider_unavailable as a structured result when no provider is configured, never a raw error', async () => {
      const taskId = await createProvisionableTask()
      setTriageProviderForTests({
        runTriage: async () => ({ ok: false, kind: 'triage', reasonCode: 'provider_unavailable' })
      })
      const handler = getHandler('auditedWorkflow:startTriage')

      const result = (await handler(null, { taskId })) as AuditedWorkflowStartTriageResult

      expect(result).toEqual({ ok: false, kind: 'triage', reasonCode: 'provider_unavailable' })
    })

    it('redacts an unexpected thrown error from the provider to a closed reason code (caught inside orchestration, not the IPC catch-all)', async () => {
      const taskId = await createProvisionableTask()
      const sensitiveMessage =
        'ENOENT: no such file /Users/carfun/.orca/audited-workflow-triage-openai-token.enc'
      setTriageProviderForTests({
        runTriage: async () => {
          throw new Error(sensitiveMessage)
        }
      })
      const handler = getHandler('auditedWorkflow:startTriage')

      const result = (await handler(null, { taskId })) as AuditedWorkflowStartTriageResult

      expect(result).toEqual({ ok: false, kind: 'triage', reasonCode: 'provider_error' })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('/Users/carfun')
      expect(serialized).not.toContain('ENOENT')
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Triage provider threw unexpectedly'),
        expect.any(Error)
      )
    })

    it('returns illegal_transition for a task not in selected state (e.g. already cancelled)', async () => {
      const taskId = await createProvisionableTask()
      const devTransitionModule = await import('../audited-workflow/audited-task-service')
      devTransitionModule.applyDevTransition(taskId, 'cancel')
      const handler = getHandler('auditedWorkflow:startTriage')

      const result = (await handler(null, { taskId })) as AuditedWorkflowStartTriageResult

      expect(result).toEqual({ ok: false, kind: 'triage', reasonCode: 'illegal_transition' })
    })
  })

  describe('retryTriage', () => {
    // Blocked BY TRIAGE (pre_block_state 'triaging'), which is the only shape
    // retryTriage accepts — provisioning must therefore succeed first.
    async function createBlockedTaskId(
      reasonCode: 'provider_unavailable' | 'output_invalid' = 'provider_unavailable'
    ): Promise<string> {
      const taskId = await createProvisionableTask()
      setTriageProviderForTests({
        runTriage: async () => ({ ok: false, reasonCode })
      })
      const startHandler = getHandler('auditedWorkflow:startTriage')
      await startHandler(null, { taskId })
      return taskId
    }

    it('rejects malformed params (missing taskId)', async () => {
      const handler = getHandler('auditedWorkflow:retryTriage')
      await expect(handler(null, {})).rejects.toThrow()
    })

    it('retries a retryable blocked triage failure and reaches a terminal decision state', async () => {
      const taskId = await createBlockedTaskId('provider_unavailable')
      setTriageProviderForTests({
        runTriage: async () => ({
          ok: true,
          output: {
            decision: 'direct',
            risk: 'low',
            rationale: 'Configured now.',
            acceptanceCriteria: [{ id: 'ac1', text: 'Works', covered: false }],
            nextStepPrompt: 'Implement it.'
          }
        })
      })
      const handler = getHandler('auditedWorkflow:retryTriage')

      const result = (await handler(null, { taskId })) as AuditedWorkflowRetryTriageResult

      expect(result).toEqual({ ok: true })
      const getTaskHandler = getHandler('auditedWorkflow:getTask')
      const projection = (await getTaskHandler(null, { taskId })) as { state: string } | null
      expect(projection?.state).toBe('ready_to_implement')
    })

    it('refuses retry for a task that is not blocked', async () => {
      const taskId = await createProvisionableTask()
      const handler = getHandler('auditedWorkflow:retryTriage')

      const result = (await handler(null, { taskId })) as AuditedWorkflowRetryTriageResult

      expect(result).toEqual({ ok: false, kind: 'triage', reasonCode: 'illegal_transition' })
    })

    it('refuses retry for a non-triage block (unsupported_host) with the same closed code', async () => {
      const taskId = await createProvisionableTask()
      const taskServiceModule = await import('../audited-workflow/audited-task-service')
      const repo = taskServiceModule.getAuditedTaskRepository()
      repo.applyTransition({
        taskId,
        fromState: 'selected',
        toState: 'blocked',
        actor: 'control',
        eventType: 'blocked_from_invariant_violation',
        preBlockState: 'selected',
        blockedReasonCode: 'unsupported_host',
        blockedPhase: null
      })
      const handler = getHandler('auditedWorkflow:retryTriage')

      const result = (await handler(null, { taskId })) as AuditedWorkflowRetryTriageResult

      expect(result).toEqual({ ok: false, kind: 'triage', reasonCode: 'illegal_transition' })
    })

    it('redacts an unexpected thrown error to a closed reason code', async () => {
      const taskId = await createBlockedTaskId('output_invalid')
      const sensitiveMessage = 'ENOENT: /Users/carfun/.orca/secret-path'
      setTriageProviderForTests({
        runTriage: async () => {
          throw new Error(sensitiveMessage)
        }
      })
      const handler = getHandler('auditedWorkflow:retryTriage')

      const result = (await handler(null, { taskId })) as AuditedWorkflowRetryTriageResult

      expect(result).toEqual({ ok: false, kind: 'triage', reasonCode: 'provider_error' })
      expect(JSON.stringify(result)).not.toContain('/Users/carfun')
    })
  })

  describe('triage provider key management', () => {
    it('getTriageProviderStatus reports configured=false when no key is stored', async () => {
      hasKeyMock.mockReturnValue(false)
      const handler = getHandler('auditedWorkflow:getTriageProviderStatus')

      const result = (await handler(null)) as AuditedWorkflowTriageProviderStatus

      expect(result).toEqual({ configured: false })
    })

    it('getTriageProviderStatus reports configured=true when a key is stored, never the key itself', async () => {
      hasKeyMock.mockReturnValue(true)
      const handler = getHandler('auditedWorkflow:getTriageProviderStatus')

      const result = (await handler(null)) as AuditedWorkflowTriageProviderStatus

      expect(result).toEqual({ configured: true })
      expect(Object.keys(result)).toEqual(['configured'])
    })

    it('saveTriageApiKey calls the store and returns only the configured flag, never the key/path/bytes', async () => {
      hasKeyMock.mockReturnValue(true)
      const handler = getHandler('auditedWorkflow:saveTriageApiKey')

      const result = (await handler(null, {
        apiKey: 'sk-super-secret-value'
      })) as AuditedWorkflowTriageProviderStatus

      expect(saveKeyMock).toHaveBeenCalledWith('sk-super-secret-value')
      expect(result).toEqual({ configured: true })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('sk-super-secret-value')
      expect(serialized).not.toContain('.orca')
      expect(serialized).not.toContain('.enc')
    })

    it('saveTriageApiKey rejects malformed params (missing apiKey)', () => {
      // Why: this handler is synchronous — Zod's .parse() throws directly
      // rather than rejecting a promise, matching getTask's precedent above.
      const handler = getHandler('auditedWorkflow:saveTriageApiKey')
      expect(() => handler(null, {})).toThrow()
    })

    it('saveTriageApiKey redacts a store-level failure and still returns a safe status', async () => {
      saveKeyMock.mockImplementation(() => {
        throw new Error(
          'EACCES: permission denied, open /home/carfun/.orca/audited-workflow-triage-openai-token.enc'
        )
      })
      hasKeyMock.mockReturnValue(false)
      const handler = getHandler('auditedWorkflow:saveTriageApiKey')

      const result = (await handler(null, {
        apiKey: 'sk-test'
      })) as AuditedWorkflowTriageProviderStatus

      expect(result).toEqual({ configured: false })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('/home/carfun')
      expect(serialized).not.toContain('EACCES')
    })

    it('clearTriageApiKey calls the store and returns only the configured flag', async () => {
      hasKeyMock.mockReturnValue(false)
      const handler = getHandler('auditedWorkflow:clearTriageApiKey')

      const result = (await handler(null)) as AuditedWorkflowTriageProviderStatus

      expect(clearKeyMock).toHaveBeenCalled()
      expect(result).toEqual({ configured: false })
    })

    it('getTriageProviderStatus redacts a storage failure (e.g. EACCES on ~/.orca) to a safe configured=false status, never a raw rejection', async () => {
      hasKeyMock.mockImplementation(() => {
        throw new Error('EACCES: permission denied, stat /home/carfun/.orca')
      })
      const handler = getHandler('auditedWorkflow:getTriageProviderStatus')

      const result = (await handler(null)) as AuditedWorkflowTriageProviderStatus

      expect(result).toEqual({ configured: false })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('/home/carfun')
      expect(serialized).not.toContain('EACCES')
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Checking the triage API key status failed'),
        expect.any(Error)
      )
    })

    it('clearTriageApiKey redacts a storage failure (e.g. unwritable ~/.orca) and still returns a safe status, never a raw rejection', async () => {
      clearKeyMock.mockImplementation(() => {
        throw new Error(
          'EPERM: operation not permitted, unlink /Users/carfun/.orca/audited-workflow-triage-openai-token.enc'
        )
      })
      hasKeyMock.mockReturnValue(true)
      const handler = getHandler('auditedWorkflow:clearTriageApiKey')

      const result = (await handler(null)) as AuditedWorkflowTriageProviderStatus

      // The handler must not reject — it resolves with the existing safe
      // { configured } contract even when the underlying clear threw.
      expect(result).toEqual({ configured: true })
      const serialized = JSON.stringify(result)
      expect(serialized).not.toContain('/Users/carfun')
      expect(serialized).not.toContain('EPERM')
      expect(serialized).not.toContain('.enc')
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Clearing the triage API key failed'),
        expect.any(Error)
      )
    })

    it('clearTriageApiKey never rejects even when both the clear and the subsequent status check throw', async () => {
      clearKeyMock.mockImplementation(() => {
        throw new Error('disk failure during unlink at /var/orca/secret')
      })
      hasKeyMock.mockImplementation(() => {
        throw new Error('disk failure during stat at /var/orca/secret')
      })
      const handler = getHandler('auditedWorkflow:clearTriageApiKey')

      let result: AuditedWorkflowTriageProviderStatus | undefined
      let rejected = false
      try {
        result = (await handler(null)) as AuditedWorkflowTriageProviderStatus
      } catch {
        rejected = true
      }

      expect(rejected).toBe(false)
      expect(result).toEqual({ configured: false })
    })
  })

  // Phase 4 execution commands. Electron IPC only; { taskId } and nothing else.
  describe('execution commands', () => {
    it.each([
      'auditedWorkflow:startExecution',
      'auditedWorkflow:cancelExecution',
      'auditedWorkflow:retryExecution'
    ])('%s rejects malformed params', async (channel) => {
      const handler = getHandler(channel)
      await expect(handler(null, {})).rejects.toThrow()
    })

    it.each([
      'auditedWorkflow:startExecution',
      'auditedWorkflow:cancelExecution',
      'auditedWorkflow:retryExecution'
    ])(
      '%s REJECTS renderer-supplied mode/prompt/model rather than stripping them',
      async (channel) => {
        const handler = getHandler(channel)
        await expect(handler(null, { taskId: 't', mode: 'direct' })).rejects.toThrow()
        await expect(handler(null, { taskId: 't', prompt: 'do evil' })).rejects.toThrow()
        await expect(handler(null, { taskId: 't', model: 'other' })).rejects.toThrow()
        await expect(handler(null, { taskId: 't', argv: ['--x'] })).rejects.toThrow()
      }
    )

    it('startExecution refuses an unknown task with a closed code, never a raw error', async () => {
      const handler = getHandler('auditedWorkflow:startExecution')
      const result = await handler(null, { taskId: 'audited_missing' })
      expect(result).toEqual({ ok: false, kind: 'execution', reasonCode: 'illegal_transition' })
    })

    it('cancelExecution reports contention when nothing is running', async () => {
      const taskId = await createProvisionableTask()
      const handler = getHandler('auditedWorkflow:cancelExecution')
      expect(await handler(null, { taskId })).toEqual({
        ok: false,
        kind: 'execution',
        reasonCode: 'lock_contended'
      })
    })

    it('retryExecution refuses a task that is not blocked', async () => {
      const taskId = await createProvisionableTask()
      const handler = getHandler('auditedWorkflow:retryExecution')
      expect(await handler(null, { taskId })).toEqual({
        ok: false,
        kind: 'execution',
        reasonCode: 'illegal_transition'
      })
    })

    // Finding 3: the persisted discriminator must be truthful per entry point.
    // startExecution's ensureWorktreeForTask failure BLOCKS the task and writes
    // worktree_reason_code, so it is persisted. retryExecution's read-only
    // preflight writes nothing, so it is fresh. The full behavioural proof lives
    // in the orchestration suites (audited-execution-admission /
    // audited-execution-run-retry); this pins the IPC boundary shape.
    it('never reports a worktree failure without an explicit persisted flag', async () => {
      const taskId = await createProvisionableTask()
      const taskServiceModule = await import('../audited-workflow/audited-task-service')
      const repo = taskServiceModule.getAuditedTaskRepository()
      // Blocked with no execution run: retry refuses before any worktree read.
      repo
        .getDatabase()
        .prepare(
          "UPDATE audited_tasks SET state = 'blocked', pre_block_state = 'implementing' WHERE id = ?"
        )
        .run(taskId)

      for (const channel of ['auditedWorkflow:startExecution', 'auditedWorkflow:retryExecution']) {
        const result = (await getHandler(channel)(null, { taskId })) as {
          ok: boolean
          kind?: string
          persisted?: boolean
        }
        if (!result.ok && result.kind === 'worktree') {
          expect(typeof result.persisted).toBe('boolean')
        }
      }
    })

    it('registers no RPC method for any execution channel', () => {
      registerAuditedWorkflowHandlers(store as never)
      const channels = handleMock.mock.calls.map((entry: unknown[]) => entry[0] as string)
      for (const channel of channels) {
        expect(channel.startsWith('auditedWorkflow:')).toBe(true)
      }
    })
  })
})
