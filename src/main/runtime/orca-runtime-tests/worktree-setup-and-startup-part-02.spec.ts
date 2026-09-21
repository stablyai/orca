import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV,
  computeWorktreePathMock,
  createSetupRunnerScript,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees,
  runHook,
  shouldRunSetupForCreate
} from '../orca-runtime-test-mocks.spec'
import { expectStablePaneKeyEnv, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('sequences setup before startup for opted-in local headless worktree creates', async () => {
    const waitRepo = {
      ...store.getRepo('repo-1')!,
      hookSettings: {
        mode: 'auto' as const,
        setupRunPolicy: 'run-by-default' as const,
        setupAgentStartupPolicy: 'wait-for-setup' as const,
        scripts: { setup: '', archive: '' }
      }
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [waitRepo],
      getRepo: (id: string) => (id === 'repo-1' ? waitRepo : undefined)
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-headless-startup' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-headless-startup' })
      .mockResolvedValueOnce({ id: 'pty-headless-setup' })
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-headless-startup-setup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-headless-startup-setup')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-headless-startup-setup'
      },
      waitForAgentStartup: true
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-headless-startup-setup',
        head: 'def',
        branch: 'runtime-headless-startup-setup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-headless-startup-setup',
      setupDecision: 'run',
      startup: { command: 'claude', viewMode: 'chat' }
    })

    expect(createSetupRunnerScript).toHaveBeenCalled()
    expect(runHook).not.toHaveBeenCalled()
    expect(createTerminal).toHaveBeenCalledWith(
      `id:${result.worktree.id}`,
      expect.objectContaining({ viewMode: 'chat' })
    )
    // Why: setup is provisioned fire-and-forget; the wait-for-setup guarantee comes from the shell nonce/marker, not JS spawn ordering.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const startup = spawn.mock.calls[0]![0] as {
      command: string
      env: Record<string, string>
    }
    const startupCommand = startup.command
    const startupScript = startup.env[SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV]!
    const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
    const nonceMatch = startupScript.match(/if \[ "\$seen" = ([0-9a-f-]+) \]/)
    expect(nonceMatch?.[1]).toBeTruthy()
    expect(startupCommand.length).toBeLessThan(256)
    expect(startupScript).toContain('exec claude')
    expect(startupScript).toContain('/mnt/c/tmp/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('bash /mnt/c/tmp/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('printf')
    expect(setupCommand).toContain(`${nonceMatch![1]} "$status"`)
    expect(result.setup).toBeUndefined()
  })

  it('starts setup and startup side by side by default for local headless worktree creates', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-headless-parallel' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-headless-parallel-startup' })
      .mockResolvedValueOnce({ id: 'pty-headless-parallel-setup' })
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-headless-parallel')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-headless-parallel')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-headless-parallel'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-headless-parallel',
        head: 'def',
        branch: 'runtime-headless-parallel',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-headless-parallel',
      setupDecision: 'run',
      startup: { command: 'claude' },
      observeSetupCompletion: true,
      awaitTerminalProvisioning: true
    })

    // Why: setup now spawns fire-and-forget on a later tick; wait for both PTYs.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(1, expect.objectContaining({ command: 'claude' }))
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        command: expect.stringContaining('__ORCA_SETUP_COMPLETE__:')
      })
    )
    expect(result.setupReceipt).toMatchObject({
      state: 'running',
      terminalHandle: expect.stringMatching(/^term_/)
    })
  })

  it('observes setup completion through the launch shell the runner was written for', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-observed-wsl-shell' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-observed-wsl-startup' })
      .mockResolvedValueOnce({ id: 'pty-observed-wsl-setup' })
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-observed-wsl-shell')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-observed-wsl-shell')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm worktree:setup'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
      shell: { family: 'posix', executable: 'wsl.exe' },
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-observed-wsl-shell'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-observed-wsl-shell',
        head: 'def',
        branch: 'runtime-observed-wsl-shell',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-observed-wsl-shell',
      setupDecision: 'run',
      startup: { command: 'claude' },
      observeSetupCompletion: true,
      awaitTerminalProvisioning: true
    })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const setupCommand = (spawn.mock.calls[1]![0] as { command: string }).command
    expect(setupCommand).toContain('bash /mnt/c/tmp/repo/.git/orca/setup-runner.sh')
    expect(setupCommand).toContain('__ORCA_SETUP_COMPLETE__:')
  })

  it('creates the first terminal for CLI-created worktrees without activating them', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-created-worktree' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-created-worktree' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-initial-terminal')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-initial-terminal',
        head: 'def',
        branch: 'runtime-initial-terminal',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-initial-terminal'
    })

    expect(activateWorktree).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-initial-terminal',
        worktreeId: result.worktree.id,
        preAllocatedHandle: expect.stringMatching(/^term_/)
      })
    )
    const initialSpawnEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expectStablePaneKeyEnv(initialSpawnEnv)
    const initialLeafId = initialSpawnEnv.ORCA_PANE_KEY.slice(
      `${initialSpawnEnv.ORCA_TAB_ID}:`.length
    )
    // Why: the renderer treats a missing surfaceOwner as "reveal the owner", which
    // scrolled the sidebar to background CLI creates.
    expect(revealTerminalSession).toHaveBeenCalledWith(result.worktree.id, {
      ptyId: 'pty-created-worktree',
      title: null,
      activate: false,
      surfaceOwner: false,
      tabId: initialSpawnEnv.ORCA_TAB_ID,
      leafId: initialLeafId
    })
  })

  it('does not surface the new workspace when a background CLI create launches its agent', async () => {
    const runtime = new OrcaRuntimeService(store)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-background-agent' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-background-agent' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-background-agent')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-background-agent')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-background-agent',
        head: 'def',
        branch: 'runtime-background-agent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-background-agent',
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    // `orca worktree create --agent claude` without --activate: the agent tab is
    // adopted, but the sidebar must stay on whatever the user was reading.
    expect(activateWorktree).not.toHaveBeenCalled()
    expect(revealTerminalSession).toHaveBeenCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-background-agent',
        activate: false,
        surfaceOwner: false
      })
    )
  })

  it('still surfaces the new workspace when the caller explicitly activates it', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-activated-agent' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-activated-agent' })
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-activated-agent')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-activated-agent')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-activated-agent',
        head: 'def',
        branch: 'runtime-activated-agent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-activated-agent',
      activate: true,
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    // No-regression guard: an explicit --activate still reveals the workspace, so
    // surfaceOwner must stay absent.
    const revealPayload = revealTerminalSession.mock.calls[0]?.[1] as
      | { surfaceOwner?: boolean }
      | undefined
    expect(revealTerminalSession).toHaveBeenCalledWith(
      result.worktree.id,
      expect.objectContaining({ ptyId: 'pty-activated-agent' })
    )
    expect(revealPayload).not.toHaveProperty('surfaceOwner')
  })

  it('still surfaces the new workspace when hooks run in the foreground', async () => {
    const runtime = new OrcaRuntimeService(store)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-hooks-agent' })
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-hooks-agent' })
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-hooks-agent')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-hooks-agent')
    vi.mocked(getEffectiveHooks).mockReturnValue(null)
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-hooks-agent',
        head: 'def',
        branch: 'runtime-hooks-agent',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-hooks-agent',
      runHooks: true,
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    const revealPayload = revealTerminalSession.mock.calls[0]?.[1] as
      | { surfaceOwner?: boolean }
      | undefined
    expect(revealTerminalSession).toHaveBeenCalledWith(
      result.worktree.id,
      expect.objectContaining({ ptyId: 'pty-hooks-agent' })
    )
    expect(revealPayload).not.toHaveProperty('surfaceOwner')
  })

  it('honors split setup placement for CLI-created worktrees without startup agents', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-vertical' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-cli-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-cli-setup-main' })
      .mockResolvedValueOnce({ id: 'pty-cli-setup-setup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree,
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-split')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-split')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: {
        setup: 'pnpm install'
      }
    })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-cli-setup-split'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-setup-split',
        head: 'def',
        branch: 'runtime-cli-setup-split',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-cli-setup-split',
      setupDecision: 'run'
    })

    expect(activateWorktree).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
    expectStablePaneKeyEnv(mainEnv)
    expectStablePaneKeyEnv(setupEnv)
    expect(setupEnv.ORCA_TAB_ID).toBe(mainEnv.ORCA_TAB_ID)
    const mainLeafId = mainEnv.ORCA_PANE_KEY!.slice(`${mainEnv.ORCA_TAB_ID!}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-cli-setup-setup',
        tabId: mainEnv.ORCA_TAB_ID,
        activate: false,
        splitFromLeafId: mainLeafId,
        splitDirection: 'vertical'
      })
    )
  })
})
