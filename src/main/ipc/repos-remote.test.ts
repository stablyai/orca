import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type * as GitRunner from '../git/runner'
import type * as RepoModule from '../git/repo'

const { reposMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./repos-remote-test-harness')
  return { reposMocks: moduleMocks.createReposIpcMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(reposMocks))
vi.mock('../git/repo', async (importOriginal) =>
  moduleMocks.gitRepoModuleMock(await importOriginal<typeof RepoModule>())
)
vi.mock('../git/runner', async (importOriginal) =>
  moduleMocks.gitRunnerModuleMock(reposMocks, await importOriginal<typeof GitRunner>())
)
vi.mock('../git/worktree', () => moduleMocks.gitWorktreeModuleMock(reposMocks))
vi.mock('./registered-worktree-roots-cache', () =>
  moduleMocks.registeredWorktreeRootsCacheModuleMock(reposMocks)
)
vi.mock('../worktree-root-preparation', () =>
  moduleMocks.worktreeRootPreparationModuleMock(reposMocks)
)
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(reposMocks))
vi.mock('../providers/ssh-filesystem-dispatch', () =>
  moduleMocks.sshFilesystemDispatchModuleMock(reposMocks)
)
vi.mock('./ssh', () => moduleMocks.sshModuleMock(reposMocks))
vi.mock('../ssh/ssh-target-registry', () => moduleMocks.sshModuleMock(reposMocks))

import { registerRepoHandlers } from './repos'
import { clearGitCapabilityStateForTests } from '../git/git-capability-state'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { DEFAULT_REPO_BADGE_COLOR } from '../../shared/constants'
import { clearSubmodulePathsCacheForTests } from '../git/status'
import { createRepoHandlerHarness, waitForAssertion } from './repos-remote-test-harness'

const {
  handleMock,
  mockStore,
  mockGitProvider,
  mockFilesystemProvider,
  mockMultiplexer,
  gitExecFileAsyncMock,
  gitSpawnMock,
  prepareLocalWorktreeRootForRepoMock
} = reposMocks

beforeEach(() => {
  clearGitCapabilityStateForTests()
  resetSshProviderAuthorities()
})

describe('repos:addRemote', () => {
  const { handlers, mockWindow, captureHandlers } = createRepoHandlerHarness()

  beforeEach(() => {
    captureHandlers(handleMock)
    mockStore.getRepos.mockReset().mockReturnValue([])
    mockStore.addRepo.mockReset()
    mockStore.removeProject.mockReset()
    mockStore.getSshTarget.mockReset()
    mockStore.updateRepo.mockReset()
    mockGitProvider.isGitRepoAsync.mockReset()
    mockGitProvider.isGitRepoAsync.mockResolvedValue({ isRepo: true, rootPath: null })
    mockGitProvider.exec.mockReset()
    mockGitProvider.exec.mockResolvedValue({ stdout: '', stderr: '' })
    mockGitProvider.clone.mockReset()
    mockGitProvider.clone.mockResolvedValue({ stdout: '', stderr: '' })
    mockGitProvider.getHostPlatform.mockReset()
    mockGitProvider.getHostPlatform.mockReturnValue({
      relayPlatform: 'linux-x64',
      os: 'linux',
      arch: 'x64',
      pathFlavor: 'posix',
      commandDialect: 'posix',
      pathSeparator: '/',
      pathDelimiter: ':'
    })
    mockFilesystemProvider.stat.mockReset()
    mockFilesystemProvider.stat.mockRejectedValue(new Error('not found'))
    mockFilesystemProvider.createDirNoClobber.mockReset()
    mockFilesystemProvider.createDirNoClobber.mockResolvedValue(undefined)
    mockFilesystemProvider.deletePath.mockReset()
    mockFilesystemProvider.deletePath.mockResolvedValue(undefined)
    mockMultiplexer.request.mockReset()
    mockMultiplexer.notify.mockReset()
    gitSpawnMock.mockReset()
    gitExecFileAsyncMock.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
    clearSubmodulePathsCacheForTests()
    prepareLocalWorktreeRootForRepoMock.mockReset().mockResolvedValue(undefined)
    gitSpawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter }
      proc.stderr = new EventEmitter()
      setImmediate(() => proc.emit('close', 0, null))
      return proc
    })
    mockWindow.webContents.send.mockReset()

    registerRepoHandlers(mockWindow as never, mockStore as never, {} as never)
  })

  it('registers the repos:addRemote handler', () => {
    expect(handlers.has('repos:addRemote')).toBe(true)
  })

  it('registers the repos:cloneRemote handler', () => {
    expect(handlers.has('repos:cloneRemote')).toBe(true)
  })

  it('registers the repos:createRemote handler', () => {
    expect(handlers.has('repos:createRemote')).toBe(true)
  })

  it('creates a remote repo with connectionId', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/project',
        connectionId: 'conn-1',
        kind: 'git',
        displayName: 'project',
        badgeColor: DEFAULT_REPO_BADGE_COLOR,
        projectHostSetupMethod: 'imported-existing-folder'
      })
    )
    expect(result).toHaveProperty('repo.id')
    expect(result).toHaveProperty('repo.connectionId', 'conn-1')
    expect(result).not.toHaveProperty('repo.externalWorktreeVisibility')
  })

  it('uses custom displayName when provided', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project',
      displayName: 'My Server Repo'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'My Server Repo',
        path: '/home/user/project'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'My Server Repo')
  })

  it('clones a repo on an SSH target and registers the cloned path', async () => {
    const result = await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })

    expect(mockFilesystemProvider.createDir).toHaveBeenCalledWith('/home/user')
    expect(mockGitProvider.clone).toHaveBeenCalledWith(
      ['clone', '--progress', '--', 'https://github.com/stablyai/orca.git', 'orca'],
      '/home/user',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: 10 * 60_000,
        onProgress: expect.any(Function)
      })
    )
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/orca',
        connectionId: 'conn-1',
        kind: 'git',
        displayName: 'orca',
        badgeColor: DEFAULT_REPO_BADGE_COLOR
      })
    )
    expect(mockMultiplexer.notify).toHaveBeenCalledWith('session.registerRoot', {
      rootPath: '/home/user/orca'
    })
    expect(result).toHaveProperty('path', '/home/user/orca')
    expect(result).toHaveProperty('connectionId', 'conn-1')
  })

  it('forwards SSH clone progress through the existing clone progress event', async () => {
    mockGitProvider.clone.mockImplementationOnce(
      async (
        _args: string[],
        _cwd: string,
        options?: { onProgress?: (progress: { phase: string; percent: number }) => void }
      ) => {
        options?.onProgress?.({ phase: 'Receiving objects', percent: 42 })
        return { stdout: '', stderr: '' }
      }
    )

    await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:clone-progress', {
      phase: 'Receiving objects',
      percent: 42
    })
  })

  it('returns an existing SSH repo instead of cloning the same target again', async () => {
    const existing = {
      id: 'existing-id',
      path: '/home/user/orca',
      connectionId: 'conn-1',
      displayName: 'orca',
      badgeColor: '#fff',
      addedAt: 1000,
      kind: 'git'
    }
    mockStore.getRepos.mockReturnValue([existing])

    const result = await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })

    expect(result).toBe(existing)
    expect(mockGitProvider.clone).not.toHaveBeenCalled()
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('upgrades an existing SSH folder repo after cloning into that path', async () => {
    const existing = {
      id: 'existing-folder',
      path: '/home/user/orca',
      connectionId: 'conn-1',
      displayName: 'orca',
      badgeColor: '#fff',
      addedAt: 1000,
      kind: 'folder'
    }
    const updated = { ...existing, kind: 'git' }
    mockStore.getRepos.mockReturnValue([existing])
    mockStore.updateRepo.mockReturnValue(updated)

    const result = await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })

    expect(mockGitProvider.clone).toHaveBeenCalledWith(
      ['clone', '--progress', '--', 'https://github.com/stablyai/orca.git', 'orca'],
      '/home/user',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        timeoutMs: 10 * 60_000,
        onProgress: expect.any(Function)
      })
    )
    expect(mockStore.updateRepo).toHaveBeenCalledWith('existing-folder', {
      kind: 'git',
      projectHostSetupMethod: 'cloned'
    })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
    expect(result).toBe(updated)
  })

  it('does not delete a fresh SSH clone target after git clone fails', async () => {
    mockGitProvider.clone.mockRejectedValueOnce(new Error('repository not found'))
    mockFilesystemProvider.stat.mockRejectedValueOnce(new Error('not found'))

    await expect(
      handlers.get('repos:cloneRemote')!(null, {
        connectionId: 'conn-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/home/user'
      })
    ).rejects.toThrow('repository not found')

    expect(mockFilesystemProvider.deletePath).not.toHaveBeenCalled()
  })

  it('rejects concurrent SSH clones to the same destination', async () => {
    let releaseClone!: () => void
    mockGitProvider.clone.mockImplementationOnce(
      async () =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          releaseClone = () => resolve({ stdout: '', stderr: '' })
        })
    )

    const firstClone = handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })
    await waitForAssertion(() => expect(mockGitProvider.clone).toHaveBeenCalledTimes(1))

    await expect(
      handlers.get('repos:cloneRemote')!(null, {
        connectionId: 'conn-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/home/user'
      })
    ).rejects.toThrow('A clone is already in progress for this SSH destination')

    releaseClone()
    await firstClone
  })

  it('resolves SSH clone destinations under home before validating the path', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu/projects' })

    await handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '~/projects'
    })

    expect(mockMultiplexer.request).toHaveBeenCalledWith('session.resolveHome', {
      path: '~/projects'
    })
    expect(mockGitProvider.clone).toHaveBeenCalledWith(
      ['clone', '--progress', '--', 'https://github.com/stablyai/orca.git', 'orca'],
      '/home/ubuntu/projects',
      expect.any(Object)
    )
  })

  it('does not clean up a pre-existing SSH clone target after git clone fails', async () => {
    mockGitProvider.clone.mockRejectedValueOnce(new Error('destination already exists'))
    mockFilesystemProvider.stat.mockResolvedValueOnce({ type: 'directory', size: 0, mtime: 0 })

    await expect(
      handlers.get('repos:cloneRemote')!(null, {
        connectionId: 'conn-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/home/user'
      })
    ).rejects.toThrow('destination already exists')

    expect(mockFilesystemProvider.deletePath).not.toHaveBeenCalled()
  })

  it('aborts an active SSH clone and reports the abort without deleting pre-existing targets', async () => {
    mockFilesystemProvider.stat.mockResolvedValueOnce({ type: 'directory', size: 0, mtime: 0 })
    mockGitProvider.clone.mockImplementationOnce(
      async (_args: string[], _cwd: string, options?: { signal?: AbortSignal }) =>
        new Promise<{ stdout: string; stderr: string }>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(new Error('aborted by test')))
        })
    )

    const clonePromise = handlers.get('repos:cloneRemote')!(null, {
      connectionId: 'conn-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/home/user'
    })
    await waitForAssertion(() => expect(mockGitProvider.clone).toHaveBeenCalledTimes(1))

    await handlers.get('repos:cloneAbort')!(null, undefined)

    await expect(clonePromise).rejects.toThrow('Clone aborted')
    const options = mockGitProvider.clone.mock.calls[0][2] as { signal: AbortSignal }
    expect(options.signal.aborted).toBe(true)
    expect(mockFilesystemProvider.deletePath).not.toHaveBeenCalled()
  })

  it('rejects SSH clone destinations that are not absolute host paths', async () => {
    await expect(
      handlers.get('repos:cloneRemote')!(null, {
        connectionId: 'conn-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: 'relative/path'
      })
    ).rejects.toThrow('Clone destination must be an absolute path on the SSH host')

    expect(mockGitProvider.clone).not.toHaveBeenCalled()
  })

  it('creates a new git project on an SSH target', async () => {
    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'created',
      kind: 'git'
    })

    expect(mockFilesystemProvider.createDirNoClobber).toHaveBeenCalledWith('/home/user/created')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(['init'], '/home/user/created')
    expect(mockGitProvider.exec).toHaveBeenCalledWith(
      ['commit', '--allow-empty', '-m', 'Initial commit'],
      '/home/user/created'
    )
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/created',
        connectionId: 'conn-1',
        kind: 'git',
        displayName: 'created'
      })
    )
    expect(result).toHaveProperty('repo.path', '/home/user/created')
    expect(result).toHaveProperty('repo.connectionId', 'conn-1')
  })

  it('resolves SSH create parents under home before validating the path', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu/projects' })

    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '~/projects',
      name: 'created',
      kind: 'folder'
    })

    expect(mockMultiplexer.request).toHaveBeenCalledWith('session.resolveHome', {
      path: '~/projects'
    })
    expect(mockFilesystemProvider.createDirNoClobber).toHaveBeenCalledWith(
      '/home/ubuntu/projects/created'
    )
    expect(result).toHaveProperty('repo.path', '/home/ubuntu/projects/created')
  })

  it('creates a new folder project on an SSH target without git init', async () => {
    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'notes',
      kind: 'folder'
    })

    expect(mockFilesystemProvider.createDirNoClobber).toHaveBeenCalledWith('/home/user/notes')
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/notes',
        connectionId: 'conn-1',
        kind: 'folder',
        displayName: 'notes'
      })
    )
    expect(result).toHaveProperty('repo.kind', 'folder')
  })

  it('rejects SSH create parent paths that are not absolute host paths', async () => {
    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: 'relative/path',
      name: 'created',
      kind: 'git'
    })

    expect(result).toEqual({ error: 'Parent directory must be an absolute path on the SSH host' })
    expect(mockFilesystemProvider.createDirNoClobber).not.toHaveBeenCalled()
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('rejects non-empty existing SSH create targets', async () => {
    mockFilesystemProvider.stat.mockResolvedValueOnce({ type: 'directory', size: 0, mtime: 0 })
    mockFilesystemProvider.readDir.mockResolvedValueOnce([
      { name: 'package.json', isDirectory: false, isSymlink: false }
    ])

    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'created',
      kind: 'git'
    })

    expect(result).toEqual({
      error: '"created" already exists at this location and is not empty.'
    })
    expect(mockFilesystemProvider.createDirNoClobber).not.toHaveBeenCalled()
    expect(mockGitProvider.exec).not.toHaveBeenCalled()
  })

  it('removes a newly created SSH directory when git init fails', async () => {
    mockGitProvider.exec.mockRejectedValueOnce(new Error('git init failed'))

    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'created',
      kind: 'git'
    })

    expect(result).toEqual({ error: 'Failed to initialize git repository: git init failed' })
    expect(mockFilesystemProvider.deletePath).toHaveBeenCalledWith('/home/user/created', true)
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('preserves an existing empty SSH directory and removes only .git when commit fails', async () => {
    mockFilesystemProvider.stat.mockResolvedValueOnce({ type: 'directory', size: 0, mtime: 0 })
    mockFilesystemProvider.readDir.mockResolvedValueOnce([])
    mockGitProvider.exec
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(new Error('Please tell me who you are'))

    const result = await handlers.get('repos:createRemote')!(null, {
      connectionId: 'conn-1',
      parentPath: '/home/user',
      name: 'created',
      kind: 'git'
    })

    expect(result).toEqual({
      error:
        'Git author identity is not configured on the SSH host. Run `git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` on that host, then try again.'
    })
    expect(mockFilesystemProvider.deletePath).toHaveBeenCalledWith('/home/user/created/.git', true)
    expect(mockFilesystemProvider.deletePath).not.toHaveBeenCalledWith('/home/user/created', true)
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('returns existing repo if same connectionId and path already added', async () => {
    const existing = {
      id: 'existing-id',
      path: '/home/user/project',
      connectionId: 'conn-1',
      displayName: 'project',
      badgeColor: '#fff',
      addedAt: 1000,
      kind: 'git'
    }
    mockStore.getRepos.mockReturnValue([existing])

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project'
    })

    expect(result).toEqual({ repo: existing })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('throws when SSH connection is not found', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'unknown-conn',
      remotePath: '/home/user/project'
    })
    expect(result).toEqual({ error: 'SSH connection "unknown-conn" not found or not connected' })
  })

  it('throws when remote path is not a git repo', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({ isRepo: false, rootPath: null })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/documents'
    })
    expect(result).toEqual({ error: 'Not a valid git repository: /home/user/documents' })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('adds as folder when kind is explicitly set', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/documents',
      kind: 'folder'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'folder',
        path: '/home/user/documents',
        badgeColor: DEFAULT_REPO_BADGE_COLOR
      })
    )
    expect(result).toHaveProperty('repo.kind', 'folder')
  })

  it('uses rootPath from git detection when available', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({
      isRepo: true,
      rootPath: '/home/user/project'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project/src'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'git',
        path: '/home/user/project'
      })
    )
    expect(result).toHaveProperty('repo.path', '/home/user/project')
  })

  it('uses the resolved git root basename for the default remote display name', async () => {
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({
      isRepo: true,
      rootPath: '/home/user/project'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project/src'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/user/project',
        displayName: 'project'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'project')
  })

  it('derives default remote display names from Windows path separators', async () => {
    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: 'C:\\Users\\alice\\project',
      kind: 'folder'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'C:\\Users\\alice\\project',
        displayName: 'project'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'project')
  })

  it('notifies renderer when remote repo is added', async () => {
    await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/project'
    })

    expect(mockWindow.webContents.send).toHaveBeenCalledWith('repos:changed')
  })

  it('resolves ~ to absolute path via relay and uses SSH target label', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu' })
    mockStore.getSshTarget.mockReturnValueOnce({
      id: 'conn-1',
      label: 'ubuntu-box',
      host: '192.168.1.100',
      port: 22,
      username: 'user'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '~'
    })

    expect(mockMultiplexer.request).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'ubuntu-box',
        path: '/home/ubuntu'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'ubuntu-box')
    expect(result).toHaveProperty('repo.path', '/home/ubuntu')
  })

  it('resolves ~/subdir to absolute path via relay', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu/subdir' })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '~/subdir'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/ubuntu/subdir',
        displayName: 'subdir'
      })
    )
    expect(result).toHaveProperty('repo.path', '/home/ubuntu/subdir')
  })

  it('returns an existing SSH repo when a selected subdirectory resolves to the repo root', async () => {
    const existing = {
      id: 'existing-id',
      path: '/home/user/orca',
      connectionId: 'conn-1',
      displayName: 'orca',
      badgeColor: '#fff',
      addedAt: 1000,
      kind: 'git'
    }
    mockStore.getRepos.mockReturnValue([existing])
    mockGitProvider.isGitRepoAsync.mockResolvedValueOnce({
      isRepo: true,
      rootPath: '/home/user/orca'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '/home/user/orca/src'
    })

    expect(result).toEqual({ repo: existing })
    expect(mockStore.addRepo).not.toHaveBeenCalled()
  })

  it('ignores SSH target label when custom displayName is provided', async () => {
    mockMultiplexer.request.mockResolvedValueOnce({ resolvedPath: '/home/ubuntu' })
    mockStore.getSshTarget.mockReturnValueOnce({
      id: 'conn-1',
      label: 'ubuntu-box',
      host: '192.168.1.100',
      port: 22,
      username: 'user'
    })

    const result = await handlers.get('repos:addRemote')!(null, {
      connectionId: 'conn-1',
      remotePath: '~',
      displayName: 'My Home'
    })

    expect(mockStore.addRepo).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'My Home',
        path: '/home/ubuntu'
      })
    )
    expect(result).toHaveProperty('repo.displayName', 'My Home')
  })
})
