import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV,
  addWorktree,
  closeRemoteWatcherForWorktreePathMock,
  deleteWorktreeHistoryDirMock,
  getActiveMultiplexerMock,
  getEffectiveHooks,
  getEffectiveHooksFromConfig,
  hasHooksFile,
  listWorktrees,
  loadHooks,
  muxRequestMock,
  parseOrcaYaml,
  registerSshFilesystemProvider,
  registerSshGitProvider,
  removeWorktree,
  shouldRunSetupForCreate,
  unregisterSshFilesystemProvider,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import {
  TEST_REPO_ID,
  TEST_REPO_PATH,
  isOriginMainBaseRefProbe,
  makeWorktreeMeta,
  store,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('launches SSH setup terminals for runtime task-created worktrees', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/mobile-setup',
      head: 'def',
      branch: 'refs/heads/mobile-setup',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      hookSettings: {
        mode: 'auto' as const,
        setupRunPolicy: 'run-by-default' as const,
        setupAgentStartupPolicy: 'wait-for-setup' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
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
        if (args[0] === 'rev-parse' && args[1] === '--git-path') {
          return {
            stdout: '/remote/repo/.git/worktrees/mobile-setup/orca/setup-runner.sh\n',
            stderr: ''
          }
        }
        if (args[0] === 'rev-parse') {
          throw new Error('missing local branch')
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({ isBinary: false, content: 'hooks:\n' }),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    vi.mocked(getEffectiveHooksFromConfig).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-remote-agent' })
      .mockResolvedValueOnce({ id: 'pty-remote-setup' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-remote' })
    registerSshGitProvider('ssh-1', provider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-setup',
        setupDecision: 'run',
        startup: { command: 'claude', viewMode: 'chat' }
      })

      // Why: runtime provisions setup itself (fire-and-forget) and omits it from the RPC result so the caller doesn't double-spawn.
      expect(result.setup).toBeUndefined()
      expect(createTerminal).toHaveBeenCalledWith(
        `path:${result.worktree.path}`,
        expect.objectContaining({ viewMode: 'chat' })
      )
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
      expect(spawn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          cwd: '/remote/mobile-setup',
          env: expect.objectContaining({
            [SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]: expect.stringContaining('exec claude')
          }),
          worktreeId: result.worktree.id
        })
      )
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          cwd: '/remote/mobile-setup',
          command: expect.stringContaining(
            'bash /remote/repo/.git/worktrees/mobile-setup/orca/setup-runner.sh'
          ),
          worktreeId: result.worktree.id
        })
      )
      const startup = spawn.mock.calls[0]![0] as {
        command: string
        env: Record<string, string>
      }
      const startupCommand = startup.command
      const startupScript = startup.env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]!
      const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
      const nonceMatch = startupScript.match(/if \[ "\$seen" = ([0-9a-f-]+) \]/)
      expect(nonceMatch?.[1]).toBeTruthy()
      const markerPath = `/remote/repo/.git/worktrees/mobile-setup/orca/setup-runner.sh.${nonceMatch![1]}.done`
      expect(startupCommand.length).toBeLessThan(256)
      expect(setupCommand).toContain('printf')
      expect(setupCommand).toContain(`${nonceMatch![1]} "$status"`)
      expect(startupScript).toContain(markerPath)
      expect(setupCommand).toContain(markerPath)
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-remote-setup',
          title: 'Setup',
          activate: false
        })
      )
    } finally {
      unregisterSshGitProvider('ssh-1')
      unregisterSshFilesystemProvider('ssh-1')
    }
  })

  it('honors split setup placement for SSH worktrees without startup agents', async () => {
    vi.mocked(listWorktrees).mockClear()
    vi.mocked(addWorktree).mockClear()
    const created = {
      path: '/remote/mobile-setup-split',
      head: 'def',
      branch: 'refs/heads/mobile-setup-split',
      isBare: false,
      isMainWorktree: false
    }
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const metaById: Record<string, WorktreeMeta> = {}
    const remoteStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-horizontal' as const
      }),
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
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
        if (args[0] === 'rev-parse' && args[1] === '--git-path') {
          return {
            stdout: '/remote/repo/.git/worktrees/mobile-setup-split/orca/setup-runner.sh\n',
            stderr: ''
          }
        }
        if (args[0] === 'rev-parse') {
          throw new Error('missing local branch')
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      addWorktree: vi.fn().mockResolvedValue(undefined),
      listWorktrees: vi.fn().mockResolvedValue([created])
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({ isBinary: false, content: 'hooks:\n' }),
      createDir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    }
    vi.mocked(getEffectiveHooksFromConfig).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-remote-initial' })
      .mockResolvedValueOnce({ id: 'pty-remote-setup-split' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-remote-split' })
    registerSshGitProvider('ssh-1', provider as never)
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    getActiveMultiplexerMock.mockReturnValue({ request: muxRequestMock, notify: vi.fn() })
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession,
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    try {
      const result = await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'mobile-setup-split',
        setupDecision: 'run'
      })

      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
      const initialEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
      const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
      expect(setupEnv.ORCA_TAB_ID).toBe(initialEnv.ORCA_TAB_ID)
      const initialLeafId = initialEnv.ORCA_PANE_KEY!.slice(`${initialEnv.ORCA_TAB_ID!}:`.length)
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-remote-setup-split',
          tabId: initialEnv.ORCA_TAB_ID,
          activate: false,
          splitFromLeafId: initialLeafId,
          splitDirection: 'horizontal'
        })
      )
    } finally {
      unregisterSshGitProvider('ssh-1')
      unregisterSshFilesystemProvider('ssh-1')
    }
  })

  it('removes SSH-backed runtime worktrees through the SSH git provider', async () => {
    vi.mocked(listWorktrees).mockClear()
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
      })
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const ptyProvider = {
      listProcesses: vi.fn().mockResolvedValue([
        {
          id: 'pty-remote',
          cwd: '/remote/feature',
          title: 'shell',
          worktreeId: `${TEST_REPO_ID}::/remote/feature`
        }
      ]),
      shutdown: vi.fn().mockResolvedValue(undefined),
      deleteWorktreeHistory: vi.fn().mockResolvedValue(undefined)
    }
    const runtime = new OrcaRuntimeService(remoteStore as never, undefined, {
      getSshProvider: () => ptyProvider as never
    })

    try {
      await runtime.removeManagedWorktree('path:/remote/feature', true, false)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.removeWorktree).toHaveBeenCalledWith('/remote/feature', true)
    expect(ptyProvider.shutdown).toHaveBeenCalledWith(
      'pty-remote',
      expect.objectContaining({ immediate: true })
    )
    expect(ptyProvider.deleteWorktreeHistory).toHaveBeenCalledWith(
      `${TEST_REPO_ID}::/remote/feature`
    )
    expect(ptyProvider.shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      gitProvider.removeWorktree.mock.invocationCallOrder[0]
    )
    expect(closeRemoteWatcherForWorktreePathMock).toHaveBeenCalledWith('ssh-1', '/remote/feature')
    expect(closeRemoteWatcherForWorktreePathMock.mock.invocationCallOrder[0]).toBeLessThan(
      gitProvider.removeWorktree.mock.invocationCallOrder[0]
    )
    expect(removeWorktree).not.toHaveBeenCalled()
    expect(listWorktrees).not.toHaveBeenCalled()
    expect(deleteWorktreeHistoryDirMock).toHaveBeenCalledWith(`${TEST_REPO_ID}::/remote/feature`)
  })

  // Regression: `repoId::path` ids repeat across hosts, so the SSH delete's runtime sweep used to
  // stop the same-id local workspace's terminals too.
  it('leaves a same-id local terminal running when the SSH copy is removed', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteStore = { ...store, getRepos: () => [remoteRepo], getRepo: () => remoteRepo }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        },
        {
          path: '/remote/feature',
          head: 'abc',
          branch: 'feature/foo',
          isBare: false,
          isMainWorktree: false
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const ptyProvider = {
      listProcesses: vi.fn().mockResolvedValue([]),
      shutdown: vi.fn().mockResolvedValue(undefined)
    }
    const runtime = new OrcaRuntimeService(remoteStore as never, undefined, {
      getSshProvider: () => ptyProvider as never
    })
    const stopAndWait = vi.fn(async () => true)
    runtime.setPtyController({
      write: () => true,
      kill: vi.fn(() => true),
      stopAndWait,
      getForegroundProcess: async () => null
    })
    syncSinglePty(runtime, null)
    runtime.registerPty('pty-remote', `${TEST_REPO_ID}::/remote/feature`, 'ssh-1')
    runtime.registerPty('pty-local-same-id', `${TEST_REPO_ID}::/remote/feature`, null)

    try {
      await runtime.removeManagedWorktree('path:/remote/feature', true, false)
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(stopAndWait).toHaveBeenCalledWith('pty-remote', expect.anything())
    expect(stopAndWait).not.toHaveBeenCalledWith('pty-local-same-id', expect.anything())
  })

  it('rejects SSH-backed runtime removal of the main worktree before provider deletion', async () => {
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
      })
    }
    const gitProvider = {
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: '/remote/repo',
          head: 'main',
          branch: 'refs/heads/main',
          isBare: false,
          isMainWorktree: true
        }
      ]),
      removeWorktree: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', gitProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.removeManagedWorktree('path:/remote/repo', true)).rejects.toThrow(
        'Refusing to delete protected worktree path: /remote/repo'
      )
    } finally {
      unregisterSshGitProvider('ssh-1')
    }

    expect(gitProvider.removeWorktree).not.toHaveBeenCalled()
    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('reads SSH repo hooks through the SSH filesystem provider', async () => {
    const remoteStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: 'C:/remote/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          connectionId: 'ssh-1'
        }
      ]
    }
    const fsProvider = {
      readFile: vi.fn().mockResolvedValue({
        content: 'scripts:\n  setup: pnpm install\n',
        isBinary: false
      })
    }
    vi.mocked(parseOrcaYaml).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    registerSshFilesystemProvider('ssh-1', fsProvider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)

    try {
      await expect(runtime.getRepoHooks('id:repo-1')).resolves.toMatchObject({
        hasHooksFile: true,
        hooks: { scripts: { setup: 'pnpm install' } },
        source: 'orca.yaml',
        setupTrust: {
          contentHash: '005d0b7e5c261dcc5e2f8568e69a0b30e889a3275b55b18ec20a7deef0081e90',
          scriptContent: 'pnpm install'
        }
      })
    } finally {
      unregisterSshFilesystemProvider('ssh-1')
    }

    expect(fsProvider.readFile).toHaveBeenCalledWith('C:\\remote\\repo\\orca.yaml')
    expect(hasHooksFile).not.toHaveBeenCalled()
    expect(getEffectiveHooks).not.toHaveBeenCalled()
  })

  it('hashes only the shared orca.yaml setup script for local run-both hooks', async () => {
    vi.mocked(hasHooksFile).mockReturnValue(true)
    vi.mocked(loadHooks).mockReturnValue({ scripts: { setup: 'echo yaml setup' } })
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { setup: 'echo yaml setup\necho local setup' }
    })
    const runtimeStore = {
      ...store,
      getRepos: () => [
        {
          id: TEST_REPO_ID,
          path: TEST_REPO_PATH,
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1,
          hookSettings: {
            commandSourcePolicy: 'run-both' as const,
            scripts: { setup: 'echo local setup' }
          }
        }
      ]
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(runtime.getRepoHooks('id:repo-1')).resolves.toMatchObject({
      hooks: { scripts: { setup: 'echo yaml setup\necho local setup' } },
      setupTrust: {
        contentHash: '9bc9f57699fe0390d263cca1aec01235cccc8fa5fc87cd87fd51ba1c8483ec84',
        scriptContent: 'echo yaml setup'
      }
    })
  })
})
