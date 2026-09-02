import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  OrcaRuntimeService,
  addWorktree,
  computeWorktreePathMock,
  createSetupRunnerScript,
  detectInstalledAgentsWithShellPathHydrationMock,
  detectRemoteAgentsMock,
  ensurePathWithinWorkspaceMock,
  getDefaultTabsLaunch,
  getEffectiveHooks,
  listWorktrees,
  shouldRunSetupForCreate
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, makeWorktreeMeta, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('does not surface the new workspace when a background create splits its setup pane', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-horizontal' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const activateWorktree = vi.fn()
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-bg-split-main' })
      .mockResolvedValueOnce({ id: 'pty-bg-split-setup' })
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-bg-split-setup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-bg-split-setup')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-bg-split-setup'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-bg-split-setup',
        head: 'def',
        branch: 'runtime-bg-split-setup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-bg-split-setup',
      setupDecision: 'run'
    })

    // Split launch modes reach the renderer through splitTerminal, not
    // createTerminal — that path must suppress owner surfacing too.
    expect(activateWorktree).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    const mainEnv = (spawn.mock.calls[0]![0] as { env?: Record<string, string> }).env ?? {}
    await vi.waitFor(() =>
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-bg-split-setup',
          tabId: mainEnv.ORCA_TAB_ID,
          activate: false,
          surfaceOwner: false,
          splitDirection: 'horizontal'
        })
      )
    )
  })

  it('still surfaces the new workspace when an activating create splits its setup pane', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        setupScriptLaunchMode: 'split-horizontal' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-active-setup-split' })
    const spawn = vi
      .fn()
      .mockResolvedValueOnce({ id: 'pty-active-split-main' })
      .mockResolvedValueOnce({ id: 'pty-active-split-setup' })
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-active-split-setup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-active-split-setup')
    vi.mocked(getEffectiveHooks).mockReturnValue({ scripts: { setup: 'pnpm install' } })
    vi.mocked(shouldRunSetupForCreate).mockReturnValue(true)
    vi.mocked(createSetupRunnerScript).mockReturnValue({
      runnerScriptPath: '/tmp/repo/.git/orca/setup-runner.sh',
      envVars: {
        ORCA_ROOT_PATH: '/tmp/repo',
        ORCA_WORKTREE_PATH: '/tmp/workspaces/runtime-active-split-setup'
      }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-active-split-setup',
        head: 'def',
        branch: 'runtime-active-split-setup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-active-split-setup',
      activate: true,
      setupDecision: 'run',
      createdWithAgent: 'claude',
      startup: { command: 'claude' }
    })

    // No-regression guard: an explicit --activate still reveals the workspace.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(revealTerminalSession).toHaveBeenLastCalledWith(
        result.worktree.id,
        expect.objectContaining({
          ptyId: 'pty-active-split-setup',
          splitDirection: 'horizontal'
        })
      )
    )
    const splitRevealPayload = revealTerminalSession.mock.lastCall?.[1] as
      | { surfaceOwner?: boolean }
      | undefined
    expect(splitRevealPayload).not.toHaveProperty('surfaceOwner')
  })

  it('does not warn when setup is explicitly skipped for CLI-created worktrees', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-setup-skip' })
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-setup-skip' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-skip')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-setup-skip')
    vi.mocked(getEffectiveHooks).mockReturnValue({
      scripts: { setup: 'pnpm worktree:setup' }
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-setup-skip',
        head: 'def',
        branch: 'runtime-cli-setup-skip',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-cli-setup-skip',
      setupDecision: 'skip',
      awaitTerminalProvisioning: true
    })

    expect(result.warning).toBeUndefined()
    expect(result.setupReceipt).toMatchObject({ requested: 'skip', state: 'skipped' })
    expect(createSetupRunnerScript).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledTimes(1)
  })

  it('materializes default tabs for inactive local managed worktree creates', async () => {
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
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
      .mockResolvedValueOnce({ id: 'pty-default-dev' })
      .mockResolvedValueOnce({ id: 'pty-default-test' })
    const revealTerminalSession = vi
      .fn()
      .mockResolvedValueOnce({ tabId: 'tab-default-dev' })
      .mockResolvedValueOnce({ tabId: 'tab-default-test' })
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

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-default-tabs')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-default-tabs')
    vi.mocked(getDefaultTabsLaunch).mockReturnValue({
      runCommands: true,
      tabs: [
        { title: 'Dev', command: 'pnpm dev' },
        { title: 'Test', command: 'pnpm test' }
      ]
    })
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-default-tabs',
        head: 'def',
        branch: 'runtime-default-tabs',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-default-tabs',
      setupDecision: 'run'
    })

    expect(result.defaultTabs).toEqual({
      runCommands: true,
      tabs: [
        { title: 'Dev', command: 'pnpm dev' },
        { title: 'Test', command: 'pnpm test' }
      ]
    })
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2))
    expect(spawn.mock.calls[0]![0]).toMatchObject({ command: 'pnpm dev' })
    expect(spawn.mock.calls[1]![0]).toMatchObject({ command: 'pnpm test' })
    expect(revealTerminalSession).toHaveBeenNthCalledWith(
      1,
      result.worktree.id,
      expect.objectContaining({ title: 'Dev', activate: false })
    )
    expect(revealTerminalSession).toHaveBeenNthCalledWith(
      2,
      result.worktree.id,
      expect.objectContaining({ title: 'Test', activate: false })
    )
  })

  it('uses desktop task agent selection and bracketed-pastes startup drafts for local worktrees', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    detectInstalledAgentsWithShellPathHydrationMock.mockResolvedValue(['claude'])
    const metaById: Record<string, WorktreeMeta> = {}
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'codex' as const,
        agentCmdOverrides: { codex: 'codex --profile work' }
      }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-startup-draft' })
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-startup-draft' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-startup-draft')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-startup-draft')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-startup-draft',
        head: 'def',
        branch: 'runtime-startup-draft',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const draftUrl = 'https://github.com/stablyai/orca/issues/123'
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-startup-draft',
      startupDraft: draftUrl,
      activate: true
    })

    expect(detectInstalledAgentsWithShellPathHydrationMock).not.toHaveBeenCalled()
    expect(detectRemoteAgentsMock).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-startup-draft',
        command: "codex --profile work '--dangerously-bypass-approvals-and-sandbox'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })

    runtime.onPtyData('pty-startup-draft', '\x1b[?2004h', Date.now())
    await vi.advanceTimersByTimeAsync(10_000)
    expect(write).not.toHaveBeenCalled()

    runtime.onPtyData('pty-startup-draft', '›', Date.now())
    await Promise.resolve()
    await Promise.resolve()

    expect(write).toHaveBeenCalledWith('pty-startup-draft', `\x1b[200~${draftUrl}\x1b[201~`)
  })

  it('keeps the 8s main-runtime startup readiness budget for non-Codex agents', async () => {
    vi.useFakeTimers()
    onTestFinished(() => {
      vi.useRealTimers()
    })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        defaultTuiAgent: 'opencode' as const,
        agentCmdOverrides: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-opencode-draft-timeout' })
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-opencode-draft-timeout' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-opencode-draft-timeout')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-opencode-draft-timeout')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-opencode-draft-timeout',
        head: 'def',
        branch: 'runtime-opencode-draft-timeout',
        isBare: false,
        isMainWorktree: false
      }
    ])

    await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'runtime-opencode-draft-timeout',
      startupDraft: 'https://github.com/stablyai/orca/issues/456'
    })

    await vi.advanceTimersByTimeAsync(7999)
    expect(write).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    runtime.onPtyData('pty-opencode-draft-timeout', '\x1b[?2004h\x1b[?25h', Date.now())
    await Promise.resolve()
    await Promise.resolve()

    expect(write).not.toHaveBeenCalled()
  })

  it('rejects explicit startup commands for disabled selected agents', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex' as const]
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-disabled-startup' })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createManagedWorktree({
        repoSelector: TEST_REPO_ID,
        name: 'disabled-startup',
        startup: { command: 'codex' },
        createdWithAgent: 'codex'
      })
    ).rejects.toThrow('Selected agent is disabled. Choose an enabled agent before creating.')

    expect(spawn).not.toHaveBeenCalled()
    expect(addWorktree).not.toHaveBeenCalled()
  })

  it('launches explicit startup agents with prompts for CLI-created worktrees', async () => {
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
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli-agent-startup' })
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
      revealTerminalSession: vi.fn().mockResolvedValue({ tabId: 'tab-cli-agent-startup' }),
      splitTerminal: vi.fn(),
      renameTerminal: vi.fn(),
      focusTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      sleepWorktree: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    })
    runtime.attachWindow(1)

    computeWorktreePathMock.mockReturnValue('/tmp/workspaces/runtime-cli-agent-startup')
    ensurePathWithinWorkspaceMock.mockReturnValue('/tmp/workspaces/runtime-cli-agent-startup')
    vi.mocked(listWorktrees).mockResolvedValue([
      {
        path: '/tmp/workspaces/runtime-cli-agent-startup',
        head: 'def',
        branch: 'runtime-cli-agent-startup',
        isBare: false,
        isMainWorktree: false
      }
    ])

    const result = await runtime.createManagedWorktree({
      repoSelector: TEST_REPO_ID,
      name: 'runtime-cli-agent-startup',
      startupAgent: 'codex',
      startupPrompt: 'hi'
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: '/tmp/workspaces/runtime-cli-agent-startup',
        command: "codex '--dangerously-bypass-approvals-and-sandbox' 'hi'",
        worktreeId: result.worktree.id
      })
    )
    expect(metaById[result.worktree.id]).toMatchObject({ createdWithAgent: 'codex' })
  })
})
