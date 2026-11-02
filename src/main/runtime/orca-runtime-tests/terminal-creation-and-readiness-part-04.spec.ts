import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  OrcaRuntimeService,
  electronMocks,
  getDefaultWorkspaceSession,
  ipcMain,
  setPlatform
} from '../orca-runtime-test-mocks.spec'
import { RpcDispatcher, TERMINAL_METHODS } from '../orca-runtime-test-mocks/terminal-rpc.spec'
import {
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession,
  spawnedPtyEnv,
  store
} from '../orca-runtime-test-fixtures.spec'
import type { RuntimeStore } from '../runtime-store-contract'
import { wireHeadlessServeRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  it('restores captured native Claude Agent Teams mode with fresh service env', async () => {
    setPlatform('linux')
    // Why: native panes write their tmux shim under ~/.orca.
    const home = await mkdtemp(join(tmpdir(), 'orca-agent-teams-home-'))
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    onTestFinished(async () => {
      vi.unstubAllEnvs()
      await rm(home, { recursive: true, force: true })
    })
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

    const spawnedEnv = spawnedPtyEnv(spawn.mock.calls[0]?.[0])
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

    const spawnedEnv = spawnedPtyEnv(spawn.mock.calls[0]?.[0])
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
        persistHostSessionBinding: true,
        placement: { kind: 'new-tab' }
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

  // `orca terminal create` used to ask the window to make the terminal and report failure after
  // 10 s, while the window still made it later; a retry then duplicated the terminal.
  it.each([
    ['--focus', { command: 'echo hi', focus: true, presentation: 'focused' }],
    // What the CLI sent for an interactive agent before this host ignored `rendererBacked`.
    ['interactive agent', { command: 'codex', focus: false, rendererBacked: true, activate: false }]
  ])(
    'reports the running CLI terminal, not a failure, when the window is slow (%s)',
    async (_case, params) => {
      vi.useFakeTimers()
      onTestFinished(() => {
        vi.useRealTimers()
      })
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli' })
      const windowSend = vi.fn()
      // The window answers nothing, so the real reveal times out after 10 s.
      const revealTerminalSession = vi.fn(
        () =>
          new Promise<never>((_resolve, reject) => {
            setTimeout(() => reject(new Error('Terminal reveal timed out')), 10_000)
          })
      )
      const runtime = new OrcaRuntimeService(store)
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
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: { send: windowSend }
      })
      const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })

      const response = dispatcher.dispatch({
        id: 'request-1',
        authToken: 'token',
        method: 'terminal.create',
        params: { worktree: `id:${TEST_WORKTREE_ID}`, ...params }
      })
      // Agent launch resolution does real I/O, so wait for the window to be asked first.
      await vi.waitFor(() =>
        expect(revealTerminalSession.mock.calls.length + windowSend.mock.calls.length).toBe(1)
      )
      await vi.advanceTimersByTimeAsync(10_000)

      await expect(response).resolves.toMatchObject({
        ok: true,
        result: {
          terminal: {
            handle: expect.stringMatching(/^term_/),
            worktreeId: TEST_WORKTREE_ID,
            surface: 'background',
            warning: expect.stringContaining('Terminal reveal timed out')
          }
        }
      })
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(windowSend).not.toHaveBeenCalledWith('terminal:requestTabCreate', expect.anything())
    }
  )

  it.each([
    ['the named group', { targetGroupId: 'group-named' }, { cols: 90, rows: 30 }],
    ['the active group when none is named', {}, { cols: 63, rows: 60 }]
  ])('starts a host terminal at the measured size of %s', async (_case, opts, expected) => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli' })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-active' }
    })
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      terminalGroupGridSizes: {
        'group-active': { cols: 63, rows: 60 },
        'group-named': { cols: 90, rows: 30 }
      },
      // A measured group beats the single-group size.
      singleGroupWorkspaceGridSize: { cols: 238, rows: 80 }
    })

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { command: 'codex', ...opts })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining(expected))
  })

  it("prefers the window's latest published active group over the saved one", async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli' })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-saved' }
    })
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      mobileSessionTabs: [
        {
          worktree: TEST_WORKTREE_ID,
          publicationEpoch: 'renderer:epoch-1',
          snapshotVersion: 1,
          activeGroupId: 'group-live',
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      ],
      terminalGroupGridSizes: {
        'group-saved': { cols: 63, rows: 60 },
        'group-live': { cols: 70, rows: 50 }
      }
    })

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { command: 'codex' })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cols: 70, rows: 50 }))
  })

  it.each([
    ['no saved group', undefined, { cols: 238, rows: 80 }],
    [
      'one saved group',
      [{ id: 'group-old', worktreeId: TEST_WORKTREE_ID, activeTabId: null, tabOrder: [] }],
      { cols: 238, rows: 80 }
    ],
    [
      'two saved groups',
      [
        { id: 'group-left', worktreeId: TEST_WORKTREE_ID, activeTabId: null, tabOrder: [] },
        { id: 'group-right', worktreeId: TEST_WORKTREE_ID, activeTabId: null, tabOrder: [] }
      ],
      { cols: 120, rows: 40 }
    ]
  ])(
    'sizes a workspace the window has not shown, with %s, from the single-group size',
    async (_case, tabGroups, expected) => {
      const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli' })
      const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
        ...getDefaultWorkspaceSession(),
        ...(tabGroups ? { tabGroups: { [TEST_WORKTREE_ID]: tabGroups } } : {})
      })
      const runtime = new OrcaRuntimeService(runtimeStore)
      runtime.setPtyController({
        spawn,
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [],
        leaves: [],
        terminalGroupGridSizes: { 'group-shown': { cols: 66, rows: 63 } },
        singleGroupWorkspaceGridSize: { cols: 238, rows: 80 }
      })

      await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { command: 'codex' })

      expect(spawn).toHaveBeenCalledWith(expect.objectContaining(expected))
    }
  )

  it('starts a host terminal at 120x40 when no window measured its group', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-cli' })
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeGroupIdByWorktree: { [TEST_WORKTREE_ID]: 'group-unmeasured' }
    })
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [],
      leaves: [],
      terminalGroupGridSizes: { 'group-other': { cols: 63, rows: 60 } }
    })

    await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, { command: 'codex' })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cols: 120, rows: 40 }))
  })

  it('accepts workspace-less terminal create replies only from the target renderer', async () => {
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
      runtime.createTerminal(undefined, {
        command: 'codex',
        title: 'Renderer Terminal'
      })
    ).resolves.toMatchObject({
      handle: expect.stringMatching(/^term_/),
      tabId: 'tab-renderer',
      title: 'Renderer Terminal',
      surface: 'visible'
    })
    expect(send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({
        requestId: expect.any(String),
        command: 'codex',
        title: 'Renderer Terminal'
      })
    )
    expect(electronMocks.ipcMain.removeListener).toHaveBeenCalledWith(
      'terminal:tabCreateReply',
      expect.any(Function)
    )
  })
})

function titledHeadlessRuntime() {
  const { runtimeStore, getSession } = makeRuntimeStoreWithWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO_ID,
    activeWorktreeId: TEST_WORKTREE_ID
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The shared fixture supplies RuntimeStore methods; its legacy Mock return type loses callable signatures.
  const runtime = new OrcaRuntimeService(runtimeStore as RuntimeStore)
  runtime.setPtyController({
    spawn: vi.fn(async () => ({ id: 'titled-pty' })),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  return { runtime, getSession }
}

describe('a titled terminal on a host with no window', () => {
  it('saves the title as the tab name', async () => {
    const { runtime, getSession } = titledHeadlessRuntime()

    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      title: 'cli-created'
    })

    const saved = getSession().tabsByWorktree[TEST_WORKTREE_ID]
    expect(saved?.find((tab) => tab.id === created.tabId)?.customTitle).toBe('cli-created')
  })

  // A window reads a saved name on hydration and shows it over the agent's live title, so a tab
  // the window never revealed (a background worker) must not get one.
  it('saves no name for a background terminal', async () => {
    const { runtime, getSession } = titledHeadlessRuntime()

    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      title: 'worker-1',
      presentation: 'background'
    })

    const saved = getSession().tabsByWorktree[TEST_WORKTREE_ID]?.find(
      (tab) => tab.id === created.tabId
    )
    expect(saved).toBeDefined()
    expect(saved?.customTitle ?? null).toBeNull()
  })

  it('lists the saved name once the terminal itself has no title, as after a restart', async () => {
    const { runtime } = titledHeadlessRuntime()
    const created = await runtime.createTerminal(`id:${TEST_WORKTREE_ID}`, {
      title: 'cli-created'
    })
    // A restarted host rebuilds the terminal's record from the process list, without a title.
    const pty = runtime['ptysById'].get('titled-pty')!
    pty.title = null
    pty.titleUpdatedAt = null

    const listed = await runtime.listTerminals(`id:${TEST_WORKTREE_ID}`)

    expect(listed.terminals.find((terminal) => terminal.handle === created.handle)?.title).toBe(
      'cli-created'
    )
  })
})
