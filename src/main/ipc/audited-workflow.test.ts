import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, getGitRepoRootMock, gitExecFileAsyncMock, consoleErrorSpy } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    getGitRepoRootMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    consoleErrorSpy: vi.fn()
  })
)

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock },
  BrowserWindow: {
    getAllWindows: () => []
  }
}))

vi.mock('../git/repo', () => ({
  getGitRepoRoot: getGitRepoRootMock
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { registerAuditedWorkflowHandlers } from './audited-workflow'
import { AuditedTaskRepository } from '../audited-workflow/audited-task-repository'
import { setAuditedTaskRepositoryForTests } from '../audited-workflow/audited-task-service'
import type { AuditedWorkflowSelectTaskResult } from '../../shared/audited-workflow-types'

describe('registerAuditedWorkflowHandlers', () => {
  const gitRepo1 = {
    id: 'repo1',
    path: 'C:\\repos\\repo1',
    displayName: 'Repo 1',
    connectionId: null as string | null,
    kind: 'git' as 'git' | 'folder'
  }
  const store = {
    getRepos: vi.fn(() => [gitRepo1])
  }

  beforeEach(() => {
    handleMock.mockReset()
    getGitRepoRootMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    consoleErrorSpy.mockReset()
    vi.spyOn(console, 'error').mockImplementation(consoleErrorSpy)
    store.getRepos.mockReturnValue([gitRepo1])
    getGitRepoRootMock.mockReturnValue('C:\\repos\\repo1')
    gitExecFileAsyncMock.mockResolvedValue({ stdout: `${'a'.repeat(40)}\n`, stderr: '' })
    setAuditedTaskRepositoryForTests(new AuditedTaskRepository(':memory:'))
  })

  afterEach(() => {
    setAuditedTaskRepositoryForTests(undefined)
    vi.restoreAllMocks()
  })

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
      }
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
})
