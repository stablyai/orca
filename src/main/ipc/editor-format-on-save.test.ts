import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  runFormatOnSave: vi.fn(),
  resolveRepoOwnedWorktreePath: vi.fn(),
  getSshGitProvider: vi.fn()
}))

const handleMock = mocks.handle
const removeHandlerMock = mocks.removeHandler
const runFormatOnSaveMock = mocks.runFormatOnSave
const resolveRepoOwnedWorktreePathMock = mocks.resolveRepoOwnedWorktreePath
const getSshGitProviderMock = mocks.getSshGitProvider

vi.mock('electron', () => ({
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler
  }
}))

vi.mock('../format-on-save-runner', () => ({
  runFormatOnSave: mocks.runFormatOnSave
}))

vi.mock('./repo-owned-worktree-path', () => ({
  resolveRepoOwnedWorktreePath: mocks.resolveRepoOwnedWorktreePath
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider
}))

import { registerEditorFormatOnSaveHandlers } from './editor-format-on-save'

const CONFIGURED = {
  enabled: true,
  command: 'prettier --write ${file}',
  include: ['**/*.ts']
}

function localRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'git',
    formatOnSave: CONFIGURED,
    ...overrides
  } as Repo
}

function registerWith(repo: Repo | undefined): (args: unknown) => Promise<unknown> {
  const store = { getRepo: vi.fn(() => repo) }
  registerEditorFormatOnSaveHandlers(store as never)
  const entry = handleMock.mock.calls.find((call) => call[0] === 'editor:formatOnSave')
  if (!entry) {
    throw new Error('handler was not registered')
  }
  return (args: unknown) => entry[1](null, args)
}

const VALID_ARGS = {
  repoId: 'repo-1',
  worktreePath: '/repo',
  filePath: '/repo/src/a.ts'
}

beforeEach(() => {
  handleMock.mockReset()
  removeHandlerMock.mockReset()
  runFormatOnSaveMock.mockReset()
  runFormatOnSaveMock.mockResolvedValue({ status: 'completed' })
  resolveRepoOwnedWorktreePathMock.mockReset()
  resolveRepoOwnedWorktreePathMock.mockImplementation(
    async (_repo: unknown, _store: unknown, value: string) => value
  )
  getSshGitProviderMock.mockReset()
  getSshGitProviderMock.mockReturnValue(undefined)
})

describe('editor:formatOnSave handler', () => {
  it('runs the command stored on the repo, never one supplied by the caller', async () => {
    const invoke = registerWith(localRepo())

    await invoke({ ...VALID_ARGS, command: 'rm -rf ~', settings: { command: 'rm -rf ~' } })

    expect(runFormatOnSaveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ command: CONFIGURED.command })
      })
    )
    const passed = runFormatOnSaveMock.mock.calls[0][0]
    expect(JSON.stringify(passed)).not.toContain('rm -rf')
  })

  it('refuses a worktree that belongs to a different repo', async () => {
    resolveRepoOwnedWorktreePathMock.mockRejectedValue(
      new Error('Access denied: worktree does not belong to repository')
    )
    const invoke = registerWith(localRepo())

    await expect(invoke({ ...VALID_ARGS, worktreePath: '/etc' })).rejects.toThrow('Access denied')
    expect(runFormatOnSaveMock).not.toHaveBeenCalled()
  })

  it('formats an SSH repo through its relay rather than running the command locally', async () => {
    const execNonInteractive = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })
    getSshGitProviderMock.mockReturnValue({ execNonInteractive })
    const invoke = registerWith(localRepo({ connectionId: 'ssh-target-1' }))

    await invoke(VALID_ARGS)

    const passed = runFormatOnSaveMock.mock.calls[0][0]
    expect(passed.remoteExec).toBeTypeOf('function')
    expect(passed.hostScope).toBe('ssh-target-1')
    // Why: the remote path is authorized against the repo too — the helper
    // handles the remote path shape rather than resolving it locally.
    expect(resolveRepoOwnedWorktreePathMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'repo-1' }),
      expect.anything(),
      VALID_ARGS.worktreePath
    )

    await passed.remoteExec({
      binary: '/bin/bash',
      args: ['-lc', 'fmt'],
      cwd: '/srv',
      timeoutMs: 1
    })
    expect(execNonInteractive).toHaveBeenCalledWith('/bin/bash', ['-lc', 'fmt'], '/srv', 1)
  })

  it('routes a row that names its SSH owner only through executionHostId', async () => {
    getSshGitProviderMock.mockReturnValue({ execNonInteractive: vi.fn() })
    const invoke = registerWith(localRepo({ executionHostId: 'ssh:ssh-target-2' }))

    await invoke(VALID_ARGS)

    expect(getSshGitProviderMock).toHaveBeenCalledWith('ssh-target-2')
    expect(runFormatOnSaveMock.mock.calls[0][0].hostScope).toBe('ssh-target-2')
  })

  it('skips an SSH repo whose relay is not connected', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)
    const invoke = registerWith(localRepo({ connectionId: 'ssh-target-1' }))

    await expect(invoke(VALID_ARGS)).resolves.toEqual({
      status: 'skipped',
      reason: 'unsupported-host'
    })
    expect(runFormatOnSaveMock).not.toHaveBeenCalled()
  })

  it('skips repos owned by a runtime host', async () => {
    const invoke = registerWith(localRepo({ executionHostId: 'runtime:env-1' }))

    await expect(invoke(VALID_ARGS)).resolves.toEqual({
      status: 'skipped',
      reason: 'unsupported-host'
    })
    expect(runFormatOnSaveMock).not.toHaveBeenCalled()
  })

  it('skips an unknown repo id without touching the authorizer', async () => {
    const invoke = registerWith(undefined)

    await expect(invoke(VALID_ARGS)).resolves.toEqual({
      status: 'skipped',
      reason: 'not-configured'
    })
    expect(resolveRepoOwnedWorktreePathMock).not.toHaveBeenCalled()
    expect(runFormatOnSaveMock).not.toHaveBeenCalled()
  })

  it('skips a repo that has not configured a formatter', async () => {
    const invoke = registerWith(localRepo({ formatOnSave: undefined }))

    await expect(invoke(VALID_ARGS)).resolves.toEqual({
      status: 'skipped',
      reason: 'not-configured'
    })
    expect(runFormatOnSaveMock).not.toHaveBeenCalled()
  })

  it('rejects malformed payloads before resolving any path', async () => {
    const invoke = registerWith(localRepo())

    await expect(invoke({ repoId: 'repo-1', worktreePath: '/repo' })).rejects.toThrow(
      'requires a repo, worktree, and file path'
    )
    await expect(invoke({ ...VALID_ARGS, filePath: '/repo/a\0.ts' })).rejects.toThrow(
      'Access denied'
    )
    expect(resolveRepoOwnedWorktreePathMock).not.toHaveBeenCalled()
    expect(runFormatOnSaveMock).not.toHaveBeenCalled()
  })

  it('passes the authorized path to the runner, not the caller-supplied one', async () => {
    resolveRepoOwnedWorktreePathMock.mockResolvedValue('/resolved/repo')
    const invoke = registerWith(localRepo())

    await invoke({ ...VALID_ARGS, worktreePath: '/repo/../repo' })

    expect(runFormatOnSaveMock).toHaveBeenCalledWith(
      expect.objectContaining({ worktreePath: '/resolved/repo' })
    )
  })

  it('replaces a stale handler when handlers are re-registered', () => {
    registerWith(localRepo())
    expect(removeHandlerMock).toHaveBeenCalledWith('editor:formatOnSave')
  })
})
