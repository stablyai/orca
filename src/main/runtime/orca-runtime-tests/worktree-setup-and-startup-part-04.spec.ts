import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV,
  computeWorktreePathMock,
  createSetupRunnerScript,
  detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgentsMock,
  ensurePathWithinWorkspaceMock,
  getEffectiveHooks,
  listWorktrees,
  shouldRunSetupForCreate
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, makeWorktreeMeta, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('sends follow-up prompts for CLI-created stdin-after-start startup agents', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-aider-startup' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => 'aider'
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-aider-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-startup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-startup')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-aider-startup',
        head: 'def',
        branch: 'runtime-cli-aider-startup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-cli-aider-startup',
      startupAgent: 'aider',
      startupPrompt: 'fix it'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-cli-aider-startup',
        command: "aider '--yes-always'",
        worktreeId: result.worktree.id
      })
    )
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-cli-aider-startup', 'fix it\r')
    })
  })

  it('does not send stdin-after-start prompts into a shell when the agent never starts', async () => {
    vi.useFakeTimers()
    try {
      const metaById: Record<string, WorktreeMeta> = {}
      const runtimeStore = {
        ...store,
        getSettings: () => ({
          ...store.getSettings(),
          agentCmdOverrides: {}
        }),
        getAllWorktreeMeta: () => metaById,
        getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
        setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
          metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
          return metaById[worktreeId]
        }
      }
      const runtime = new OrcaRuntimeService(runtimeStore as never)
      const write = vi.fn().mockReturnValue(true)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-cli-aider-shell' }),
        write,
        kill: () => true,
        getForegroundProcess: async () => 'zsh',
        hasChildProcesses: vi.fn().mockResolvedValue(false)
      })
      runtime.setNotifier({
        worktreesChanged: vi.fn(),
        reposChanged: vi.fn(),
        activateWorktree: vi.fn(),
        createTerminal: vi.fn(),
        revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-aider-shell' }),
        splitTerminal: vi.fn(),
        renameTerminal: vi.fn(),
        focusTerminal: vi.fn(),
        closeTerminal: vi.fn(),
        sleepWorktree: vi.fn(),
        terminalFitOverrideChanged: vi.fn(),
        terminalDriverChanged: vi.fn()
      })
      runtime.attachWindow(1)

      computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-aider-shell')
      vi.mocked(listWorktrees).mockResolvedValue([
        {
          path: '/tmp/workspaces/runtime-cli-aider-shell',
          head: 'def',
          branch: 'runtime-cli-aider-shell',
          isBare: false,
          isMainWorktree: false
        }
      ])

      await runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'runtime-cli-aider-shell',
        startupAgent: 'aider',
        startupPrompt: 'fix it'
      })

      await vi.advanceTimersByTimeAsync(6000)

      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('records the resolved fallback agent when the requested startup draft agent is disabled', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(['claude'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        disabledTuiAgents: ['codex' as const],
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-fallback-draft' })
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-fallback-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-fallback-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-fallback-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-fallback-draft',
        head: 'def',
        branch: 'runtime-fallback-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-fallback-draft',
      startupDraft: 'https://github.com/stablyai/orca/issues/456',
      createdWithAgent: 'codex',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-fallback-draft',
        command: expect.stringContaining('claude'),
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'claude' })
  })

  it('honors split setup placement for opted-in local startup-draft worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        setupScriptLaunchMode: 'split-vertical' as const
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-startup-split-main' })
      .mockResolvedValueOnce({ id: 'pty-startup-split-setup' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-startup-split' })
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-split')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-split')
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
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-split'
      },
      waitForAgentStartup: true
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-setup-split',
        head: 'def',
        branch: 'runtime-startup-setup-split',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-setup-split',
      startupDraft: 'https://github.com/stablyai/orca/issues/123',
      setupDecision: 'run',
      activate: true,
      awaitTerminalProvisioning: true
    })

    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-setup-split',
        env: expect.objectContaining({
          [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: expect.stringContaining('codex')
        }),
        worktreeId: result.worktree.id
      })
    )
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-setup-split',
        command: expect.stringContaining('bash /tmp/repo/.git/orca/setup-runner.sh'),
        env: expect.objectContaining({
          ORCA_ROOT_PATH: '/tmp/repo',
          ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-split',
          ORCA_WORKTREE_ID: result.worktree.id
        }),
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
    const markerPath = `/tmp/repo/.git/orca/setup-runner.sh.${nonceMatch![1]}.done`
    expect(startupCommand.length).toBeLessThan(256)
    expect(startupScript).toContain('--dangerously-bypass-approvals-and-sandbox')
    expect(setupCommand).toContain('printf')
    expect(setupCommand).toContain(`${nonceMatch![1]} "$status"`)
    expect(startupScript).toContain(markerPath)
    expect(setupCommand).toContain(markerPath)
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    const setupEnv = (spawn.mock.calls[1]![0] as { env?: Record<string, string> }).env ?? {}
    expect(result.setup).toBeUndefined()
    expect(result.setupReceipt).toMatchObject({
      state: 'running',
      terminalHandle: expect.stringMatching(/^term_/)
    })
    expect(mainEnv.ORCA_TAB_ID).toBeDefined()
    expect(mainEnv.ORCA_PANE_KEY).toBeDefined()
    expect(setupEnv.ORCA_TAB_ID).toBe(mainEnv.ORCA_TAB_ID)
    const mainLeafId = mainEnv.ORCA_PANE_KEY!.slice(`${mainEnv.ORCA_TAB_ID!}:`.length)
    expect(revealTerminalSession).toHaveBeenLastCalledWith(
      result.worktree.id,
      expect.objectContaining({
        ptyId: 'pty-startup-split-setup',
        tabId: mainEnv.ORCA_TAB_ID,
        activate: false,
        splitFromLeafId: mainLeafId,
        splitDirection: 'vertical'
      })
    )
  })

  it('passes the wrapped setup command to activation when startup spawned but setup did not', async () => {
    const runtime = new OrcaRuntimeService(store)
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-startup-main' })
      .mockRejectedValueOnce(new Error('setup spawn failed'))
    const activateWorktree = vi.fn()
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-startup-main' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-retry')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-setup-retry')
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
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-startup-setup-retry'
      },
      waitForAgentStartup: true
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-setup-retry',
        head: 'def',
        branch: 'runtime-startup-setup-retry',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-setup-retry',
      setupDecision: 'run',
      activate: true,
      startup: { command: 'claude' }
    })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      expect.any(String),
      expect.objectContaining({
        runnerScriptPath: 'C:\\tmp\\repo\\.git\\orca\\setup-runner.sh',
        command: expect.stringContaining('bash /mnt/c/tmp/repo/.git/orca/setup-runner.sh')
      }),
      undefined,
      undefined
    )
    const activationSetup = activateWorktree.mock.calls[0]?.[2] as { command?: string } | undefined
    expect(activationSetup?.command).toContain('printf')
  })

  it('lets explicit startup draft agents override the desktop default', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue([])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'claude' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-explicit-draft' })
    const write = vi.fn().mockReturnValue(true)
    runtime.setPtyController({
      spawn,
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.setNotifier({
      worktreesChanged: vi.fn(),
      reposChanged: vi.fn(),
      activateWorktree: vi.fn(),
      createTerminal: vi.fn(),
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-explicit-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-explicit-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-explicit-draft',
        head: 'def',
        branch: 'runtime-explicit-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const draftUrl = 'https://github.com/stablyai/orca/issues/789'
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-explicit-draft',
      startupDraft: draftUrl,
      createdWithAgent: 'codex',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-explicit-draft',
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-explicit-draft', '\x1b[?2004h›', Date.now())
    await vi.waitFor(() => {
      expect(write).toHaveBeenCalledWith('pty-explicit-draft', `\x1b[200~${draftUrl}\x1b[201~`)
    })
  })

  it('does not auto-launch an agent for startup drafts when the default is blank', async () => {
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(['claude', 'codex'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'blank' as const,
        agentCmdOverrides: {}
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-blank-draft' })
    const activateWorktree = vi.fn()
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-blank-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-blank-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-blank-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-blank-draft',
        head: 'def',
        branch: 'runtime-blank-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-blank-draft',
      startupDraft: 'https://github.com/stablyai/orca/issues/123',
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    expect(metaById[result.worktree.id]?.createdWithAgent).toBeUndefined()
    expect(activateWorktree).toHaveBeenCalledWith(
      'repo-1',
      result.worktree.id,
      undefined,
      undefined,
      undefined
    )
  })
})
