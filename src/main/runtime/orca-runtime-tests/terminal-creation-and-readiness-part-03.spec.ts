import { describe, expect, it, vi } from 'vitest'
import {
  FLOATING_TERMINAL_WORKTREE_ID,
  OrcaRuntimeService,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  electronMocks,
  homedir,
  ipcMain,
  join,
  markCodexProjectTrustedMock,
  mkdtemp,
  randomUUID,
  registerSshGitProvider,
  tmpdir,
  unregisterSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import {
  TEST_FOLDER_PROJECT_GROUP_ID,
  TEST_FOLDER_WORKSPACE_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  createFolderWorkspaceRuntimeStore,
  expectStablePaneKeyEnv,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  store
} from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('does not use the local Windows shell setting for remote Windows bare agent creates', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: 'C:/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1'
    }
    const remoteStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === TEST_REPO_ID ? remoteRepo : undefined),
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        terminalWindowsShell: 'cmd.exe',
        agentCmdOverrides: {},
        agentDefaultArgs: { claude: '--dangerously-skip-permissions' },
        agentDefaultEnv: {}
      })
    }
    const provider = {
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
      listWorktrees: vi.fn().mockResolvedValue([
        {
          path: 'C:/remote/repo',
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        }
      ])
    }
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-remote-windows-bare' })
    registerSshGitProvider('ssh-1', provider as never)
    const runtime = new OrcaRuntimeService(remoteStore as never)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    try {
      const terminal = await runtime.createTerminal('path:C:/remote/repo', {
        command: 'claude',
        title: 'worker'
      })

      const spawnCall = spawn.mock.calls[0]?.[0] as { command?: string } | undefined
      expect(spawnCall?.command).toBe("claude '--dangerously-skip-permissions'")
      expect(terminal).toMatchObject({
        executionHostId: 'ssh:ssh-1',
        hostPlatform: 'linux'
      })
    } finally {
      unregisterSshGitProvider('ssh-1')
    }
  })

  it('matches canonical bare agent commands when a command override is configured', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: { codex: 'codex --profile work' },
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as { command?: string } | undefined
    expect(spawnCall?.command).toBe(
      "codex --profile work '--dangerously-bypass-approvals-and-sandbox'"
    )
  })

  it('keeps non-bare agent command terminal creates unchanged', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex exec summarize'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe('codex exec summarize')
    expect(spawnCall?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
  })

  it('keeps disabled bare agent command terminal creates unchanged', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: ['codex' as const],
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: {}
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { command?: string; env?: Record<string, string> }
      | undefined
    expect(spawnCall?.command).toBe('codex')
    expect(spawnCall?.env?.ORCA_AGENT_LAUNCH_TOKEN).toBeUndefined()
  })

  it('sends Settings agent defaults through renderer-backed bare agent terminal creates', async () => {
    const runtimeStore = {
      ...store,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--dangerously-bypass-approvals-and-sandbox' },
        agentDefaultEnv: { codex: { CODEX_PROFILE: 'captured' } }
      })
    }
    const runtime = new OrcaRuntimeService(runtimeStore)

    const webContents = { send: vi.fn() }
    webContents.send.mockImplementation((_channel: string, payload: { requestId: string }) => {
      runtime.syncWindowGraph(1, {
        tabs: [],
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
        { requestId: payload.requestId, tabId: 'tab-renderer', title: 'Codex' }
      )
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
    electronMocks.BrowserWindow.fromId.mockReturnValue({
      isDestroyed: () => false,
      webContents
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      rendererBacked: true
    })

    expect(webContents.send).toHaveBeenCalledWith(
      'terminal:requestTabCreate',
      expect.objectContaining({
        worktreeId: TEST_WORKTREE_ID,
        command: "codex '--dangerously-bypass-approvals-and-sandbox'",
        env: { CODEX_PROFILE: 'captured' },
        launchAgent: 'codex',
        launchConfig: {
          agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
          agentArgs: '--dangerously-bypass-approvals-and-sandbox',
          agentEnv: { CODEX_PROFILE: 'captured' }
        }
      })
    )
    expect(markCodexProjectTrustedMock).toHaveBeenCalledWith(TEST_WORKTREE_PATH)
    expect(markCodexProjectTrustedMock.mock.invocationCallOrder[0]).toBeLessThan(
      webContents.send.mock.invocationCallOrder[0]!
    )
  })

  it('injects runtime hook receiver env into terminal sessions', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-hooked' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      buildAgentHookPtyEnv: () => ({
        ORCA_AGENT_HOOK_PORT: '5678',
        ORCA_AGENT_HOOK_TOKEN: 'agent-token',
        ORCA_AGENT_HOOK_ENV: 'remote',
        ORCA_AGENT_HOOK_VERSION: '1'
      })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      env: {
        ORCA_AGENT_HOOK_PORT: '1111',
        ORCA_AGENT_HOOK_TOKEN: 'stale-token',
        ORCA_AGENT_HOOK_TRANSPORT: 'stale-transport',
        ORCA_AGENT_HOOK_ENDPOINT: '/tmp/stale-endpoint.env'
      },
      envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME']
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { env?: Record<string, string>; envToDelete?: string[] }
      | undefined
    expect(spawnCall?.env).toEqual(
      expect.objectContaining({
        ORCA_AGENT_HOOK_PORT: '5678',
        ORCA_AGENT_HOOK_TOKEN: 'agent-token',
        ORCA_AGENT_HOOK_ENV: 'remote',
        ORCA_AGENT_HOOK_VERSION: '1',
        ORCA_PANE_KEY: expect.any(String),
        ORCA_TAB_ID: expect.any(String),
        ORCA_WORKTREE_ID: TEST_WORKTREE_ID
      })
    )
    expect(spawnCall?.env?.ORCA_AGENT_HOOK_ENDPOINT).toBeUndefined()
    expect(spawnCall?.env?.ORCA_AGENT_HOOK_TRANSPORT).toBeUndefined()
    expect(spawnCall?.envToDelete).toEqual(['CODEX_HOME', 'ORCA_CODEX_HOME'])
  })

  it.each([
    { label: 'canonical folder workspace selector', selector: TEST_FOLDER_WORKSPACE_KEY },
    { label: 'id-prefixed folder workspace selector', selector: `id:${TEST_FOLDER_WORKSPACE_KEY}` }
  ])('creates background terminal sessions for a $label', async ({ selector }) => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-workspace-'))
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(selector, {
        command: 'codex',
        title: 'multi-repo worker'
      })
    ).resolves.toMatchObject({
      worktreeId: TEST_FOLDER_WORKSPACE_KEY,
      title: 'multi-repo worker',
      surface: 'background'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | { cwd?: string; env?: Record<string, string>; worktreeId?: string }
      | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    expect(spawnCall).toMatchObject({
      cwd: folderPath,
      worktreeId: TEST_FOLDER_WORKSPACE_KEY
    })
    expectStablePaneKeyEnv(spawnedEnv)
    expect(spawnedEnv.ORCA_WORKSPACE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
    expect(spawnedEnv.ORCA_PROJECT_GROUP_ID).toBe(TEST_FOLDER_PROJECT_GROUP_ID)
    expect(spawnedEnv.ORCA_WORKSPACE_ROOT).toBe(folderPath)
    expect(spawnedEnv.ORCA_WORKTREE_ID).toBe(TEST_FOLDER_WORKSPACE_KEY)
  })

  it.each([
    { label: 'bare floating terminal sentinel', selector: FLOATING_TERMINAL_WORKTREE_ID },
    {
      label: 'id-prefixed floating terminal sentinel',
      selector: `id:${FLOATING_TERMINAL_WORKTREE_ID}`
    }
  ])('creates background terminal sessions for a $label', async ({ selector }) => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-floating' })
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(
      runtime.createTerminal(selector, {
        command: 'codex',
        title: 'floating worker'
      })
    ).resolves.toMatchObject({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      title: 'floating worker',
      surface: 'background'
    })

    const spawnCall = spawn.mock.calls[0]?.[0] as
      | {
          cwd?: string
          connectionId?: string | null
          env?: Record<string, string>
          worktreeId?: string
        }
      | undefined
    expect(spawnCall).toMatchObject({
      cwd: homedir(),
      connectionId: null,
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID
    })
    expect(spawnCall?.env?.ORCA_WORKTREE_ID).toBe(FLOATING_TERMINAL_WORKTREE_ID)
    expect(spawnCall?.env?.ORCA_WORKSPACE_ID).toBeUndefined()
    expect(spawnCall?.env?.ORCA_PROJECT_GROUP_ID).toBeUndefined()
    expect(spawnCall?.env?.ORCA_WORKSPACE_ROOT).toBeUndefined()
  })

  it('rejects folder workspace terminal creation when the backing path is missing', async () => {
    const missingPath = join(tmpdir(), `orca-missing-folder-workspace-${randomUUID()}`)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath: missingPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: missingPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(runtime.createTerminal(TEST_FOLDER_WORKSPACE_KEY)).rejects.toThrow(
      'folder_workspace_path_missing'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects folder workspace folderPath updates when the new path is missing', async () => {
    const missingPath = join(tmpdir(), `orca-missing-folder-update-${randomUUID()}`)
    const folderWorkspace = makeFolderWorkspace()
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(folderWorkspace),
      updateFolderWorkspace: vi.fn()
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.updateFolderWorkspace(TEST_FOLDER_WORKSPACE_ID, { folderPath: missingPath })
    ).rejects.toThrow('folder_workspace_path_missing')
    expect(runtimeStore.updateFolderWorkspace).not.toHaveBeenCalled()
  })

  it('enables Claude Agent Teams only for direct Claude launches when configured in-process', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
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

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: "claude 'hello'"
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: "echo ok; claude 'hello'"
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex'
    })

    const directClaude = spawn.mock.calls[0]?.[0] as {
      command?: string
      env?: Record<string, string>
    }
    const compoundClaude = spawn.mock.calls[1]?.[0] as {
      command?: string
      env?: Record<string, string>
    }
    const normalAgent = spawn.mock.calls[2]?.[0] as {
      command?: string
      env?: Record<string, string>
    }

    expect(directClaude.command).toBe("claude --teammate-mode in-process 'hello'")
    expect(directClaude.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
    expect(directClaude.env?.TMUX).toBeUndefined()

    expect(compoundClaude.command).toBe("echo ok; claude 'hello'")
    expect(compoundClaude.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(compoundClaude.env?.TMUX).toBeUndefined()

    expect(normalAgent.command).toBe("codex '--dangerously-bypass-approvals-and-sandbox'")
    expect(normalAgent.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBeUndefined()
    expect(normalAgent.env?.TMUX).toBeUndefined()
  })

  it('reveals Claude Agent Teams launches with the rewritten launch config', async () => {
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
      command: "claude 'hello'",
      launchAgent: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: { CLAUDE_PROFILE: 'captured' }
      }
    })

    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ launchAgent: 'claude' }))

    const spawnCall = spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined
    const spawnedEnv = spawnCall?.env ?? {}
    const spawnedLeafId = spawnedEnv.ORCA_PANE_KEY.slice(`${spawnedEnv.ORCA_TAB_ID}:`.length)
    expect(revealTerminalSession).toHaveBeenCalledWith(TEST_WORKTREE_ID, {
      ptyId: 'pty-bg',
      title: null,
      launchConfig: {
        agentCommand: 'claude --teammate-mode in-process',
        agentArgs: '',
        agentEnv: {
          CLAUDE_PROFILE: 'captured',
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'
        }
      },
      launchToken: spawnedEnv.ORCA_AGENT_LAUNCH_TOKEN,
      launchAgent: 'claude',
      activate: false,
      tabId: spawnedEnv.ORCA_TAB_ID,
      leafId: spawnedLeafId
    })
  })

  it('preserves Claude Agent Teams for sequenced Claude launches', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
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

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command:
        'bash -lc \'echo Waiting for setup to finish before starting agent... >&2; exec claude "hello"\'',
      claudeAgentTeamsSourceCommand: 'claude "hello"',
      launchAgent: 'claude',
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '',
        agentEnv: { CLAUDE_PROFILE: 'captured' }
      }
    })

    const sequencedClaude = spawn.mock.calls[0]?.[0] as {
      command?: string
      env?: Record<string, string>
    }

    expect(sequencedClaude.command).toBe(
      'bash -lc \'echo Waiting for setup to finish before starting agent... >&2; exec claude "hello"\''
    )
    expect(sequencedClaude.env?.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
    expect(sequencedClaude.env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]).toBe(
      'claude --teammate-mode in-process "hello"'
    )
  })
})
