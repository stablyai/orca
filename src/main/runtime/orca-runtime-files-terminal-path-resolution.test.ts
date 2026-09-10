import { describe, expect, it, vi } from 'vitest'
import { resolveAuthorizedPathMock, statMock } from './orca-runtime-files-mock-registry'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  resolveTerminalArtifactPath,
  statAsFile
} from './orca-runtime-files-terminal-artifact-fixtures'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/rg-availability',
  async () => (await import('./orca-runtime-files-mock-registry')).rgAvailabilityMock
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)
vi.mock(
  '../ipc/filesystem-search-git',
  async () => (await import('./orca-runtime-files-mock-registry')).filesystemSearchGitMock
)
vi.mock(
  '../providers/ssh-filesystem-dispatch',
  async () => (await import('./orca-runtime-files-mock-registry')).sshFilesystemDispatchMock
)

describe('RuntimeFileCommands', () => {
  useRuntimeFileCommandsLifecycle()

  describe('resolveTerminalPath', () => {
    it('resolves an absolute path inside the worktree to a relative path', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', '/repo/src/index.ts')

      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: 'src/index.ts',
        absolutePath: '/repo/src/index.ts',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'src/index.ts',
          absolutePath: '/repo/src/index.ts'
        }
      })
    })

    it('keeps in-worktree resolution unchanged when chat provenance is present', async () => {
      const hasRecentNativeChatOutputPath = vi.fn(() => true)
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        hasRecentNativeChatOutputPath
      })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '/repo/src/index.ts',
        null,
        'client-a',
        null,
        true,
        { tabId: 'tab-1', sessionId: 'session-1' }
      )

      expect(result).toMatchObject({ relativePath: 'src/index.ts', exists: true })
      expect(hasRecentNativeChatOutputPath).not.toHaveBeenCalled()
    })

    it('resolves an absolute path through a known sibling workspace', async () => {
      const sibling = {
        id: 'wt-2',
        repoId: 'repo-2',
        path: '/sibling',
        git: {
          path: '/sibling',
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: true
        }
      }
      const resolveKnownWorkspaceFileTarget = vi.fn(async () => ({
        worktree: sibling,
        executionHostId: 'local',
        relativePath: 'docs/readme.md'
      }))
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        resolveKnownWorkspaceFileTarget
      })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '/sibling/docs/readme.md',
        null,
        undefined,
        null,
        true
      )

      expect(resolveKnownWorkspaceFileTarget).toHaveBeenCalledWith(
        '/sibling/docs/readme.md',
        'local'
      )
      expect(result).toEqual({
        worktree: 'wt-2',
        relativePath: 'docs/readme.md',
        absolutePath: '/sibling/docs/readme.md',
        exists: true,
        isDirectory: false,
        openTarget: {
          kind: 'worktree-file',
          provider: 'local',
          relativePath: 'docs/readme.md',
          absolutePath: '/sibling/docs/readme.md'
        }
      })
    })

    it('resolves an exact local sibling workspace root as a directory without a grant', async () => {
      const sibling = {
        id: 'wt-2',
        repoId: 'repo-2',
        path: '/sibling',
        git: {
          path: '/sibling',
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: true
        }
      }
      const resolveKnownWorkspaceFileTarget = vi.fn(async () => ({
        worktree: sibling,
        executionHostId: 'local',
        relativePath: ''
      }))
      const hasRecentTerminalOutputPath = vi.fn(() => true)
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        resolveKnownWorkspaceFileTarget,
        hasRecentTerminalOutputPath
      })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => true })

      const result = await resolveTerminalArtifactPath(commands, '/sibling', null, 'client-a', true)

      expect(resolveKnownWorkspaceFileTarget).toHaveBeenCalledWith('/sibling', 'local')
      expect(result).toEqual({
        worktree: 'wt-2',
        relativePath: '',
        absolutePath: '/sibling',
        exists: true,
        isDirectory: true,
        openTarget: undefined
      })
      expect(hasRecentTerminalOutputPath).not.toHaveBeenCalled()
    })

    it('stats a sibling SSH workspace through its owning provider', async () => {
      const sibling = {
        id: 'wt-2',
        repoId: 'repo-2',
        path: '/sibling',
        hostId: 'ssh:ssh-1',
        git: {
          path: '/sibling',
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: true
        }
      }
      const resolveKnownWorkspaceFileTarget = vi.fn(async () => ({
        worktree: sibling,
        executionHostId: 'ssh:ssh-1',
        relativePath: 'docs/readme.md'
      }))
      const { commands, store } = createRuntimeFileCommands({
        path: '/repo',
        resolveKnownWorkspaceFileTarget
      })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const remoteStat = vi.fn().mockResolvedValue({ type: 'file', size: 12, mtime: 3 })
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat: remoteStat } as never)

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '/sibling/docs/readme.md',
        null,
        undefined,
        null,
        true
      )

      expect(resolveKnownWorkspaceFileTarget).toHaveBeenCalledWith(
        '/sibling/docs/readme.md',
        'ssh:ssh-1'
      )
      expect(remoteStat).toHaveBeenCalledWith('/sibling/docs/readme.md')
      expect(statMock).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        worktree: 'wt-2',
        relativePath: 'docs/readme.md',
        exists: true,
        openTarget: { provider: 'ssh' }
      })
    })

    it('stats an exact SSH sibling root as a directory through its owning provider', async () => {
      const sibling = {
        id: 'wt-2',
        repoId: 'repo-2',
        path: '/sibling',
        hostId: 'ssh:ssh-1',
        git: {
          path: '/sibling',
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: true
        }
      }
      const resolveKnownWorkspaceFileTarget = vi.fn(async () => ({
        worktree: sibling,
        executionHostId: 'ssh:ssh-1',
        relativePath: ''
      }))
      const hasRecentTerminalOutputPath = vi.fn(() => true)
      const { commands, store } = createRuntimeFileCommands({
        path: '/repo',
        resolveKnownWorkspaceFileTarget,
        hasRecentTerminalOutputPath
      })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const remoteStat = vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtime: 3 })
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat: remoteStat } as never)

      const result = await resolveTerminalArtifactPath(commands, '/sibling', null, 'client-a', true)

      expect(resolveKnownWorkspaceFileTarget).toHaveBeenCalledWith('/sibling', 'ssh:ssh-1')
      expect(remoteStat).toHaveBeenCalledWith('/sibling')
      expect(statMock).not.toHaveBeenCalled()
      expect(result).toEqual({
        worktree: 'wt-2',
        relativePath: '',
        absolutePath: '/sibling',
        exists: true,
        isDirectory: true,
        openTarget: undefined
      })
      expect(hasRecentTerminalOutputPath).not.toHaveBeenCalled()
    })

    // The host was `runtime:env-a` until this process stopped dispatching runtime hosts at all
    // (see runtime-file-target-execution-host.test.ts); an SSH host proves the same scoping on a
    // host this process actually serves.
    it('scopes sibling lookup to the selected worktree execution host', async () => {
      const resolveKnownWorkspaceFileTarget = vi.fn(async () => null)
      const { commands } = createRuntimeFileCommands({
        path: '/repo-a',
        hostId: 'ssh:openclaw',
        resolveKnownWorkspaceFileTarget
      })

      await commands.resolveTerminalPath(
        'id:wt-1',
        '/repo-b/docs/readme.md',
        null,
        undefined,
        null,
        true
      )

      expect(resolveKnownWorkspaceFileTarget).toHaveBeenCalledWith(
        '/repo-b/docs/readme.md',
        'ssh:openclaw'
      )
    })

    // Why: clients predating crossWorkspace (mobile <=0.0.36) reuse their own worktree
    // id for files.open, so they must keep the pre-sibling-resolution contract.
    it('keeps the caller worktree and a null relativePath when crossWorkspace is not requested', async () => {
      const resolveKnownWorkspaceFileTarget = vi.fn(async () => ({
        worktree: {
          id: 'wt-2',
          repoId: 'repo-2',
          path: '/sibling',
          git: { path: '/sibling', head: '', branch: '', isBare: false, isMainWorktree: true }
        },
        relativePath: 'docs/readme.md'
      }))
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        resolveKnownWorkspaceFileTarget
      })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', '/sibling/docs/readme.md')

      expect(resolveKnownWorkspaceFileTarget).not.toHaveBeenCalled()
      expect(result).toEqual({
        worktree: 'wt-1',
        relativePath: null,
        absolutePath: '/sibling/docs/readme.md',
        exists: false,
        isDirectory: false
      })
    })

    it('resolves a relative path against the provided cwd', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', 'index.ts', '/repo/src')

      expect(result).toMatchObject({ relativePath: 'src/index.ts', exists: true })
    })

    it('prefers the source terminal cwd over stale mobile cached cwd metadata', async () => {
      const resolveTerminalCwd = vi.fn(() => '/repo/current')
      const { commands } = createRuntimeFileCommands({ path: '/repo', resolveTerminalCwd })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        'index.ts',
        '/repo/stale',
        'client-a',
        'term-1'
      )

      expect(resolveTerminalCwd).toHaveBeenCalledWith('term-1')
      expect(result).toMatchObject({ relativePath: 'current/index.ts', exists: true })
    })

    it('falls back to the source terminal cwd when mobile has not cached cwd metadata', async () => {
      const resolveTerminalCwd = vi.fn(() => '/repo/src')
      const { commands } = createRuntimeFileCommands({ path: '/repo', resolveTerminalCwd })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        'index.ts',
        null,
        'client-a',
        'term-1'
      )

      expect(resolveTerminalCwd).toHaveBeenCalledWith('term-1')
      expect(result).toMatchObject({ relativePath: 'src/index.ts', exists: true })
    })

    it('awaits async source terminal cwd fallback from the PTY provider', async () => {
      const resolveTerminalCwd = vi.fn(async () => '/repo/packages/app')
      const { commands } = createRuntimeFileCommands({ path: '/repo', resolveTerminalCwd })
      statAsFile()

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        'package.json',
        null,
        'client-a',
        'term-1'
      )

      expect(result).toMatchObject({ relativePath: 'packages/app/package.json', exists: true })
    })

    it('resolves a relative path against the worktree root when no cwd is given', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      statAsFile()

      const result = await commands.resolveTerminalPath('id:wt-1', 'docs/readme.md')

      expect(result).toMatchObject({ relativePath: 'docs/readme.md', exists: true })
    })

    it('reports directories including the workspace root', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => true })

      const nestedResult = await commands.resolveTerminalPath('id:wt-1', '/repo/src')
      const rootResult = await commands.resolveTerminalPath('id:wt-1', '/repo')

      expect(nestedResult).toMatchObject({ relativePath: 'src', isDirectory: true, exists: true })
      expect(rootResult).toMatchObject({
        relativePath: '',
        isDirectory: true,
        exists: true,
        openTarget: undefined
      })
    })

    it('keeps an exact selected nested root instead of resolving it to a parent workspace', async () => {
      const resolveKnownWorkspaceFileTarget = vi.fn(async () => ({
        worktree: { id: 'wt-parent', repoId: 'repo-parent', path: '/repo' },
        relativePath: 'nested'
      }))
      const { commands } = createRuntimeFileCommands({
        path: '/repo/nested',
        resolveKnownWorkspaceFileTarget
      })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockResolvedValue({ isDirectory: () => true })

      const result = await commands.resolveTerminalPath('id:wt-1', '/repo/nested')

      expect(resolveKnownWorkspaceFileTarget).not.toHaveBeenCalled()
      expect(result).toMatchObject({
        worktree: 'wt-1',
        relativePath: '',
        isDirectory: true,
        openTarget: undefined
      })
    })

    it('reports a nonexistent in-worktree path as not existing', async () => {
      const { commands } = createRuntimeFileCommands({ path: '/repo' })
      resolveAuthorizedPathMock.mockImplementation(async (p: string) => p)
      statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))

      const result = await commands.resolveTerminalPath('id:wt-1', 'src/missing.ts')

      expect(result).toMatchObject({ relativePath: 'src/missing.ts', exists: false })
    })

    it('does not expand ~/ on a remote worktree (home is unknown)', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn()
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat } as never)

      const result = await commands.resolveTerminalPath('id:wt-1', '~/notes.md')

      expect(result).toMatchObject({ relativePath: null, exists: false })
      expect(stat).not.toHaveBeenCalled()
    })

    it('still refuses a native-chat ~/ path on a remote worktree', async () => {
      const hasRecentNativeChatOutputPath = vi.fn(() => true)
      const { commands, store } = createRuntimeFileCommands({
        path: '/repo',
        hasRecentNativeChatOutputPath
      })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })

      const result = await commands.resolveTerminalPath(
        'id:wt-1',
        '~/notes.md',
        null,
        'client-a',
        null,
        true,
        { tabId: 'tab-1', sessionId: 'session-1' }
      )

      expect(result).toMatchObject({ relativePath: null, exists: false })
      expect(hasRecentNativeChatOutputPath).not.toHaveBeenCalled()
    })

    it('reports a missing remote file as not existing', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockRejectedValue(new Error('ENOENT: no such file'))
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat } as never)

      const result = await commands.resolveTerminalPath('id:wt-1', 'src/missing.ts')

      expect(result).toMatchObject({ relativePath: 'src/missing.ts', exists: false })
    })

    it('rethrows a remote transport error instead of reporting not-found', async () => {
      const { commands, store } = createRuntimeFileCommands({ path: '/repo' })
      store.getRepo.mockReturnValue({ connectionId: 'ssh-1' })
      const stat = vi.fn().mockRejectedValue(new Error('Remote connection dropped'))
      vi.mocked(getSshFilesystemProvider).mockReturnValue({ stat } as never)

      await expect(commands.resolveTerminalPath('id:wt-1', 'src/x.ts')).rejects.toThrow(
        'Remote connection dropped'
      )
    })
  })
})
