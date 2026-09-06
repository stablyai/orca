import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  electronMocks,
  ipcMain,
  setPlatform
} from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, TEST_WORKTREE_PATH, store } from '../orca-runtime-test-fixtures.spec'
import { wireHeadlessServeRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('restores captured native Claude Agent Teams mode with fresh service env', async () => {
    setPlatform('linux')
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'off' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude --resume claude-session',
      env: {
        CLAUDE_PROFILE: 'captured',
        // Why: native panes need an absolute CLI; without one the plan degrades to in-process teammates.
        ORCA_AGENT_TEAMS_SHIM_BIN: '/opt/orca/bin/orca-ide',
        ORCA_AGENT_TEAMS_TEAM_ID: 'stale-team',
        ORCA_AGENT_TEAMS_TOKEN: 'stale-token',
        TMUX: '/tmp/orca-claude-agent-teams/stale-team,0,1'
      },
      launchAgent: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '--teammate-mode auto',
        agentEnv: {
          CLAUDE_PROFILE: 'captured',
          ORCA_AGENT_TEAMS_SHIM_BIN: '/opt/orca/bin/orca-ide',
          ORCA_AGENT_TEAMS_TEAM_ID: 'stale-team',
          ORCA_AGENT_TEAMS_TOKEN: 'stale-token',
          TMUX: '/tmp/orca-claude-agent-teams/stale-team,0,1'
        }
      }
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe('claude --teammate-mode auto --resume claude-session')
    expect(spawnCall?.env).toMatchObject({
      CLAUDE_PROFILE: 'captured',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      ORCA_AGENT_TEAMS_SHIM_BIN: '/opt/orca/bin/orca-ide',
      TMUX_PANE: '%1'
    })
    expect(spawnCall?.env?.ORCA_AGENT_TEAMS_TEAM_ID).toMatch(/^team-/)
    expect(spawnCall?.env?.ORCA_AGENT_TEAMS_TEAM_ID).not.toBe('stale-team')
    expect(spawnCall?.env?.ORCA_AGENT_TEAMS_TOKEN).not.toBe('stale-token')
    expect(spawnCall?.env?.TMUX).not.toBe('/tmp/orca-claude-agent-teams/stale-team,0,1')
    expect(revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({
        launchConfig: expect.objectContaining({
          agentCommand: 'claude --teammate-mode auto',
          agentEnv: expect.objectContaining({
            CLAUDE_PROFILE: 'captured',
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            TMUX_PANE: '%1'
          })
        }),
        launchAgent: 'claude'
      })
    )
    const revealedLaunchConfig = revealTerminalSession.mock.calls[0]?.[1]?.launchConfig
    expect(revealedLaunchConfig?.agentEnv.ORCA_AGENT_TEAMS_TEAM_ID).not.toBe('stale-team')
    expect(revealedLaunchConfig?.agentEnv.ORCA_AGENT_TEAMS_TOKEN).not.toBe('stale-token')
  })

  it('does not apply current Agent Teams mode to captured plain Claude resumes', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const revealTerminalSession = vi.fn().mockResolvedValue({ tabId: 'tab-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        claudeAgentTeamsMode: 'in-process' as const
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
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
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'claude --resume claude-session',
      launchAgent: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: { CLAUDE_PROFILE: 'captured' }
      }
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe('claude --resume claude-session')
    expect(spawnCall?.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({
        launchConfig: {
          agentCommand: 'claude',
          agentArgs: '',
          agentEnv: { CLAUDE_PROFILE: 'captured' }
        },
        launchAgent: 'claude'
      })
    )
  })

  it('adopts renderer pane identity for remote runtime terminal creates', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'tab-remote-runtime'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      focus: false,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: `${tabId}:${leafId}`,
        ORCA_TAB_ID: tabId
      }
    })

    const spawnedEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expect(spawnedEnv.ORCA_TAB_ID).toBe(tabId)
    expect(spawnedEnv.ORCA_PANE_KEY).toBe(`${tabId}:${leafId}`)
  })

  it('does not adopt web mirror ids as host terminal ids', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const tabId = 'web-terminal-host-tab-1'
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      focus: false,
      tabId,
      leafId
    })

    const spawnedEnv =
      (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
    expect(spawnedEnv.ORCA_TAB_ID).not.toBe(tabId)
    expect(spawnedEnv.ORCA_TAB_ID).not.toMatch(/^web-terminal-/)
    expect(spawnedEnv.ORCA_PANE_KEY).toMatch(`${spawnedEnv.ORCA_TAB_ID}:`)
  })

  it('creates background terminal sessions while the renderer graph is unavailable', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        persistHostSessionBinding: true
      })
    )
  })

  // Why (flipped by the aug20 "windows 2" incident): #8646 scoped the persisted
  // binding to windowless promotion, which left a host-initiated terminal on a
  // host running the full app with neither a persisted tab nor runtime
  // ownership — unclassifiable, so graph sync pruned the tab off a live agent.
  // The renderer adopts under the pre-minted tabId, so persisting early cannot
  // fork a second tab; it only makes the host's own create durable.
  it('persists the host session binding even when a window is attached', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    const webContents = { send: vi.fn() }
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    } as never)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const spawnOptions = spawn.mock.calls[0]?.[0] as
      | { persistHostSessionBinding?: boolean }
      | undefined
    expect(spawnOptions?.persistHostSessionBinding).toBe(true)
  })

  it('falls back to background terminal creation for renderer-backed requests without a renderer window', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        rendererBacked: true
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID
      })
    )
  })

  it('spawns focus-requested CLI terminal creates in background on headless serve', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-focus-headless' })
    const runtime = wireHeadlessServeRuntime()
    const revealTerminalSession = vi.fn()
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
      resumeSleepingAgents: vi.fn(),
      terminalFitOverrideChanged: vi.fn(),
      terminalDriverChanged: vi.fn()
    } as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    // `orca terminal create --worktree <wt> --command "echo test" --focus`
    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'echo test',
        focus: true
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      handle: expect.stringMatching(/^term_/)
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'echo test',
        cwd: TEST_WORKTREE_PATH,
        worktreeId: TEST_WORKTREE_ID,
        persistHostSessionBinding: true
      })
    )
    // Why: degrading the create must not silently drop the focus request — the
    // host still asks whatever surface exists to activate the new pane.
    expect(revealTerminalSession).toHaveBeenCalledWith(
      TEST_WORKTREE_ID,
      expect.objectContaining({ activate: true, presentation: 'focused' })
    )
  })

  it('spawns presentation:focused terminal creates in background on headless serve', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-presentation-headless' })
    const runtime = wireHeadlessServeRuntime()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    // Paired desktop `+` button: clients send presentation:'focused', not focus.
    await expect(
      runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
        command: 'codex',
        presentation: 'focused'
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_WORKTREE_ID,
      surface: 'background',
      handle: expect.stringMatching(/^term_/)
    })
    expect(spawn).toHaveBeenCalled()
  })

  it('spawns focused agent-session creates in background on headless serve', async () => {
    // Why: RPC only downgrades `focused` for clients that report a clientKind
    // (#10193), so loopback/CLI callers still reach the runtime asking for focus.
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-agent-headless' })
    const runtime = wireHeadlessServeRuntime()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createAgentSession({
        clientOperationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
        worktree: `path:${TEST_WORKTREE_PATH}`,
        agent: 'codex',
        prompt: 'hello',
        presentation: 'focused'
      })
    ).resolves.toMatchObject({
      disposition: 'created',
      terminal: expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        handle: expect.stringMatching(/^term_/)
      })
    })
    expect(spawn).toHaveBeenCalled()
  })

  it('activates the paired mobile session tab for a degraded focused headless create', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-focus-publish' })
    const runtime = wireHeadlessServeRuntime()
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    const created = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'echo test',
      focus: true
    })

    // Why: with no renderer notifier on a serve host, the session-tab publish is
    // the only channel a paired client learns about the terminal on — a degraded
    // focused create must still land there selected, or focus is silently lost.
    const tabs = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    const published = tabs.tabs.find(
      (tab) => tab.type === 'terminal' && tab.parentTabId === created.tabId
    )
    expect(published).toBeDefined()
    expect(published?.isActive).toBe(true)
    expect(tabs.activeTabId).toBe(published?.id)
  })

  it('keeps focus-requested terminal creates on the renderer when a window exists', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-should-not-spawn' })
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-focused',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Focused Terminal',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-focused',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-focused',
            paneTitle: null
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-focused', title: 'Focused Terminal' }
      )
    })
    webContents.send = send
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: 'echo test',
        focus: true
      })
    ).resolves.toMatchObject({
      tabId: 'tab-focused',
      worktreeId: TEST_WORKTREE_ID,
      surface: 'visible'
    })
    expect(send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({ activate: true, presentation: 'focused' })
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('accepts renderer-backed terminal create replies only from the target renderer', async () => {
    const webContents = { send: vi.fn() }
    const send = vi.fn((_channel: string, payload: { requestId: string }) => {
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: { send: vi.fn() } },
        { requestId: payload.requestId, error: 'spoofed renderer reply' }
      )
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Renderer Terminal',
            activeLeafId: 'pane:1',
            layout: null
          }
        ],
        leaves: [
          {
            tabId: 'tab-renderer',
            worktreeId: TEST_WORKTREE_ID,
            leafId: 'pane:1',
            paneRuntimeId: 1,
            ptyId: 'pty-renderer',
            paneTitle: null
          }
        ]
      })
      ipcMain.emit(
        'terminal:tabCreateReply',
        { sender: webContents },
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Renderer Terminal' }
      )
    })
    webContents.send = send
    const runtime = new OrcaRuntimeService(store)
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    await expect(
      runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: 'codex',
        rendererBacked: true,
        title: 'Renderer Terminal'
      })
    ).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: 'tab-renderer',
      title: 'Renderer Terminal',
      worktreeId: TEST_WORKTREE_ID,
      surface: 'visible'
    })
    expect(send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({
        requestId: expect.any(String),
        worktreeId: TEST_WORKTREE_ID,
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        title: 'Renderer Terminal'
      })
    )
    expect(electronMocks.ipcMain.removeListener).toHaveBeenCalledWith(
      'terminal:tabCreateReply',
      expect.any(Function)
    )
  })
})
