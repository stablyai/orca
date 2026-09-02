import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgentsMock,
  getActiveMultiplexerMock,
  muxRequestMock,
  registerSshFilesystemProvider,
  registerSshGitProvider,
  unregisterSshFilesystemProvider,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  isOriginMainBaseRefProbe,
  makeWorktreeMeta,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('forwards generated-name provenance while launching SSH startup drafts', async () => {
    detectRemoteAgentsMock.mockResolvedValue(['claude'])
    const created = {
      path: '/remote/repo-nautilus-2',
      head: 'def',
      branch: 'refs/heads/nautilus-2',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: null,
        agentCmdOverrides: {}
      }),
      getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: ['nautilus'] }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    registerSshGitProvider('ssh-1', provider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-startup-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const draftUrl = 'https://github.com/stablyai/orca/pull/456'
    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'nautilus',
      nameWasGenerated: true,
      startupDraft: draftUrl
    })

    expect(detectRemoteAgentsMock).toHaveBeenCalledWith({ connectionId: 'ssh-1' })
    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(provider.addWorktree).toHaveBeenCalledWith(
      '/remote/repo',
      'nautilus-2',
      '/remote/repo-nautilus-2',
      expect.any(Object)
    )
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/remote/repo-nautilus-2',
        command: `claude '--dangerously-skip-permissions' --prefill '${draftUrl}'`,
        connectionId: 'ssh-1',
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'claude' })
  })

  it('pre-marks remote Codex workspaces trusted before pasting startup drafts', async () => {
    detectRemoteAgentsMock.mockResolvedValue(['codex'])
    muxRequestMock.mockResolvedValue({ resolvedPath: '/home/dev' })
    const created = {
      path: '/remote/mobile-codex-draft',
      head: 'def',
      branch: 'refs/heads/mobile-codex-draft',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const gitProvider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      realpath: vi.fn().mockResolvedValue('/remote/mobile-codex-draft'),
      readFile: vi.fn().mockRejectedValue(new Error('missing config')),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-codex-draft' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-codex-draft',
        startupDraft: 'https://github.com/stablyai/orca/issues/789'
      })

      expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
      expect(muxRequestMock).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
      expect(fsProvider.createDir).toHaveBeenCalledWith('/home/dev/.codex')
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('[projects."/remote/mobile-codex-draft"]')
      )
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('trust_level = "trusted"')
      )
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/mobile-codex-draft',
          command: "codex '--dangerously-bypass-approvals-and-sandbox'",
          connectionId: 'ssh-1',
          worktreeId: result.worktree.id
        })
      )
      expect(fsProvider.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        spawn.mock.invocationCallOrder[0]!
      )
      expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('pre-marks remote Codex workspaces trusted before explicit startup commands', async () => {
    muxRequestMock.mockResolvedValue({ resolvedPath: '/home/dev' })
    const created = {
      path: '/remote/mobile-codex-command',
      head: 'def',
      branch: 'refs/heads/mobile-codex-command',
      isBare: false,
      isMainWorktree: false
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: '/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ],
      getRepo: () => ({
        id: TEST_REPO_ID,
        path: '/remote/repo',
        displayName: 'repo',
        badgeColor: 'blue',
        addedAt: 1,
        connectionId: 'ssh-1'
      }),
      getSettings: () => store.getSettings(),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const gitProvider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'config') {
          return { stdout: 'Remote User\n', stderr: '' }
        }
        if (args[0] === 'branch') {
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'symbolic-ref') {
          return { stdout: 'origin/main\n', stderr: '' }
        }
        if (isOriginMainBaseRefProbe(args)) {
          return { stdout: 'main-sha\n', stderr: '' }
        }
        if (args[0] === 'fetch') {
          return { stdout: '', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      realpath: vi.fn().mockResolvedValue('/remote/mobile-codex-command'),
      readFile: vi.fn().mockRejectedValue(new Error('missing config')),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-codex-command' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-codex-command',
        startup: { command: 'codex' },
        createdWithAgent: 'codex'
      })

      expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
      expect(muxRequestMock).toHaveBeenCalledWith('session.resolveHome', { path: '~' })
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('[projects."/remote/mobile-codex-command"]')
      )
      expect(fsProvider.writeFile).toHaveBeenCalledWith(
        '/home/dev/.codex/config.toml',
        expect.stringContaining('trust_level = "trusted"')
      )
      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/remote/mobile-codex-command',
          command: 'codex',
          connectionId: 'ssh-1',
          worktreeId: result.worktree.id
        })
      )
      expect(fsProvider.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
        spawn.mock.invocationCallOrder[0]!
      )
      expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
      unregisterSshGitProvider('ssh-1')
    }
  })
})
