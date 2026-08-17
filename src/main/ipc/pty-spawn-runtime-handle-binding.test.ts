import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { createHash } from 'node:crypto'
import { delimiter } from 'node:path'
import { makePaneKey } from '../../shared/stable-pane-id'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerPtyHandlers, registerSshPtyProvider } from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, mainWindowIpcEvent } = setupPtyIpcSuite()

  it('injects ORCA_TERMINAL_HANDLE for non-local PTY providers', async () => {
    const spawn = vi.fn(async () => ({ id: 'remote-pty' }))
    registerSshPtyProvider('ssh-1', {
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      acknowledgeDataEvent: vi.fn()
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: 'ssh-1',
      env: { EXISTING: '1' }
    })

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          EXISTING: '1',
          ORCA_TERMINAL_HANDLE: 'term_remote'
        })
      })
    )
    expect(runtime.registerPreAllocatedHandleForPty).toHaveBeenCalledWith(
      'remote-pty',
      'term_remote'
    )
  })
  it('refreshes captured native Agent Teams env for renderer PTY spawns', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_agent_teams'),
      prepareClaudeAgentTeamsLeaderForHandle: vi.fn(async () => ({
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          PATH: `/tmp/fresh-agent-teams${delimiter}/usr/bin`,
          TMUX: '/tmp/orca-claude-agent-teams/team-fresh,0,1',
          TMUX_PANE: '%1',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh',
          ORCA_AGENT_TEAMS_TOKEN: 'fresh-token'
        }
      })),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/repo',
      command: 'claude --teammate-mode auto --resume claude-session',
      tabId: 'tab-1',
      leafId,
      worktreeId: 'wt-1',
      env: {
        ORCA_PANE_KEY: `tab-1:${leafId}`,
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: 'wt-1',
        CLAUDE_PROFILE: 'captured',
        PATH: `/tmp/stale-agent-teams${delimiter}/usr/bin`,
        TMUX: '/tmp/orca-claude-agent-teams/team-stale,0,1',
        ORCA_AGENT_TEAMS_TEAM_ID: 'team-stale',
        ORCA_AGENT_TEAMS_TOKEN: 'stale-token',
        TERM_PROGRAM: 'Orca'
      },
      launchConfig: {
        agentCommand: 'claude --teammate-mode auto',
        agentArgs: '',
        agentEnv: {
          CLAUDE_PROFILE: 'captured',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-stale',
          ORCA_AGENT_TEAMS_TOKEN: 'stale-token'
        }
      },
      launchAgent: 'claude'
    })) as { launchConfig?: { agentEnv: Record<string, string> } }

    const spawnOptions = spawnMock.mock.calls.at(-1)?.[2] as { env: Record<string, string> }
    expect(runtime.prepareClaudeAgentTeamsLeaderForHandle).toHaveBeenCalledWith({
      handle: 'term_agent_teams',
      baseEnv: expect.objectContaining({
        CLAUDE_PROFILE: 'captured',
        ORCA_AGENT_TEAMS_TEAM_ID: 'team-stale'
      })
    })
    expect(spawnOptions.env).toMatchObject({
      CLAUDE_PROFILE: 'captured',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      ORCA_TERMINAL_HANDLE: 'term_agent_teams',
      ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh',
      ORCA_AGENT_TEAMS_TOKEN: 'fresh-token',
      TMUX: '/tmp/orca-claude-agent-teams/team-fresh,0,1',
      TMUX_PANE: '%1'
    })
    expect(spawnOptions.env.PATH.split(delimiter)[0]).toBe('/tmp/fresh-agent-teams')
    expect(spawnOptions.env.TERM_PROGRAM).toBeUndefined()
    expect(result.launchConfig?.agentEnv).toMatchObject({
      CLAUDE_PROFILE: 'captured',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh',
      ORCA_AGENT_TEAMS_TOKEN: 'fresh-token',
      TMUX: '/tmp/orca-claude-agent-teams/team-fresh,0,1'
    })
    expect(runtime.registerPreAllocatedHandleForPty).toHaveBeenCalledWith(
      expect.any(String),
      'term_agent_teams'
    )
  })
  it('threads the validated pane identity into registerPty for a renderer PTY spawn (#7587)', async () => {
    const leafId = '88888888-8888-4888-8888-888888888888'
    const runtime = {
      setPtyController: vi.fn(),
      preAllocateHandleForPty: vi.fn(() => 'term_seam'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/repo',
      tabId: 'tab-1',
      leafId,
      worktreeId: 'wt-1'
    })

    // Why: #7587 — the runtime can only back a stalled mobile create if the spawn threads {tabId, leafId}.
    expect(runtime.registerPty).toHaveBeenCalledWith(
      expect.any(String),
      'wt-1',
      null,
      { tabId: 'tab-1', leafId, incarnationId: expect.any(String) },
      false
    )
  })
  it.each([
    {
      label: 'matching proof',
      launchToken: 'renderer-launch-token',
      envLaunchToken: 'renderer-launch-token',
      hasLaunchConfig: true,
      launchAgent: 'claude',
      expectedToken: 'renderer-launch-token'
    },
    {
      label: 'mismatched proof',
      launchToken: 'renderer-launch-token',
      envLaunchToken: 'different-process-token',
      hasLaunchConfig: true,
      launchAgent: 'claude',
      expectedToken: null
    },
    {
      label: 'missing top-level proof',
      launchToken: undefined,
      envLaunchToken: 'renderer-launch-token',
      hasLaunchConfig: true,
      launchAgent: 'claude',
      expectedToken: null
    },
    {
      label: 'oversized proof',
      launchToken: 'x'.repeat(129),
      envLaunchToken: 'x'.repeat(129),
      hasLaunchConfig: true,
      launchAgent: 'claude',
      expectedToken: null
    },
    {
      label: 'untracked launch',
      launchToken: 'renderer-launch-token',
      envLaunchToken: 'renderer-launch-token',
      hasLaunchConfig: false,
      launchAgent: 'claude',
      expectedToken: null
    },
    {
      label: 'invalid agent identity',
      launchToken: 'renderer-launch-token',
      envLaunchToken: 'renderer-launch-token',
      hasLaunchConfig: true,
      launchAgent: 'not-an-agent',
      expectedToken: null
    },
    {
      label: 'missing agent identity',
      launchToken: 'renderer-launch-token',
      envLaunchToken: 'renderer-launch-token',
      hasLaunchConfig: true,
      launchAgent: undefined,
      expectedToken: null
    }
  ])('binds only $label from renderer pty:spawn to runtime authority', async (testCase) => {
    const runtime = new OrcaRuntimeService()
    registerPtyHandlers(mainWindow as never, runtime)
    const worktreeId = 'repo-1::/tmp/renderer-authority'
    const tabId = 'tab-renderer-authority'
    const leafId = '99999999-9999-4999-8999-999999999999'
    const paneKey = makePaneKey(tabId, leafId)

    const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/tmp/renderer-authority',
      command: 'claude',
      worktreeId,
      tabId,
      leafId,
      env: {
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: worktreeId,
        ORCA_AGENT_LAUNCH_TOKEN: testCase.envLaunchToken
      },
      ...(testCase.launchToken ? { launchToken: testCase.launchToken } : {}),
      ...(testCase.hasLaunchConfig
        ? { launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} } }
        : {}),
      ...(testCase.launchAgent ? { launchAgent: testCase.launchAgent } : {})
    })) as { id: string; incarnationId: string }

    const handle = runtime.preAllocateHandleForPty(result.id)
    const authority = runtime.getOrchestrationDispatchAuthority(handle)
    expect(authority).toMatchObject({ ptyId: result.id, paneKey })
    expect(authority?.launchTokenHash).toBe(
      testCase.expectedToken
        ? createHash('sha256').update(testCase.expectedToken).digest('hex')
        : null
    )

    if (testCase.expectedToken) {
      runtime.registerPty(result.id, worktreeId, null, {
        tabId,
        leafId,
        incarnationId: result.incarnationId,
        agentLaunchAuthority: { launchToken: 'stale-overwrite', launchAgent: 'claude' }
      })
      expect(runtime.getOrchestrationDispatchAuthority(handle)?.launchTokenHash).toBe(
        createHash('sha256').update(testCase.expectedToken).digest('hex')
      )
    }
  })
  it('omits the pane identity from registerPty when the leafId is not a terminal leaf (#7587)', async () => {
    const runtime = {
      setPtyController: vi.fn(),
      preAllocateHandleForPty: vi.fn(() => 'term_seam'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }
    handlers.clear()
    registerPtyHandlers(mainWindow as never, runtime as never)

    await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/repo',
      tabId: 'tab-1',
      leafId: 'pane:1',
      worktreeId: 'wt-1'
    })

    // Why: legacy numeric pane ids (`pane:N`) aren't leaf ids, so the seam passes a clean `undefined` (no fabricated binding).
    expect(runtime.registerPty).toHaveBeenCalledWith(
      expect.any(String),
      'wt-1',
      null,
      undefined,
      false
    )
  })
  it('refreshes native Agent Teams env when captured teammate mode lives in launch args', async () => {
    const leafId = '11111111-1111-4111-8111-111111111111'
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_agent_teams'),
      prepareClaudeAgentTeamsLeaderForHandle: vi.fn(async () => ({
        env: {
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
          ORCA_AGENT_TEAMS_TEAM_ID: 'team-fresh',
          ORCA_AGENT_TEAMS_TOKEN: 'fresh-token'
        }
      })),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24,
      cwd: '/repo',
      command: 'claude --resume claude-session',
      tabId: 'tab-1',
      leafId,
      worktreeId: 'wt-1',
      env: {
        ORCA_PANE_KEY: `tab-1:${leafId}`,
        ORCA_TAB_ID: 'tab-1',
        ORCA_WORKTREE_ID: 'wt-1'
      },
      launchConfig: {
        agentCommand: 'claude',
        agentArgs: '--teammate-mode auto',
        agentEnv: {}
      },
      launchAgent: 'claude'
    })

    expect(runtime.prepareClaudeAgentTeamsLeaderForHandle).toHaveBeenCalledWith({
      handle: 'term_agent_teams',
      baseEnv: expect.any(Object)
    })
  })
  it('does not echo launch config for provider reattach results', async () => {
    const spawn = vi.fn(async () => ({ id: 'ssh-reattach', isReattach: true }))
    registerSshPtyProvider('ssh-reattach-1', {
      spawn,
      write: vi.fn(),
      resize: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      onData: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn(),
      acknowledgeDataEvent: vi.fn()
    } as never)
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_remote'),
      registerPreAllocatedHandleForPty: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      connectionId: 'ssh-reattach-1',
      launchConfig: {
        agentCommand: 'codex --model gpt-5',
        agentArgs: '--model gpt-5',
        agentEnv: { CODEX_PROFILE: 'captured' }
      }
    })) as { id: string; isReattach?: boolean; launchConfig?: unknown }

    expect(result).toMatchObject({ id: 'ssh-reattach', isReattach: true })
    expect(result.launchConfig).toBeUndefined()
  })
  it('reuses the runtime background handle in local PTY spawn env', async () => {
    type RuntimeSpawnController = {
      spawn(args: {
        cols: number
        rows: number
        worktreeId?: string
        preAllocatedHandle?: string
      }): Promise<{ id: string }>
    }
    let controller: RuntimeSpawnController | null = null
    const runtime = {
      setPtyController: vi.fn((value) => {
        controller = value
      }),
      preAllocateHandleForPty: vi.fn(() => 'term_wrong'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      getDriver: vi.fn(() => ({ kind: 'host' })),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn()
    }

    registerPtyHandlers(mainWindow as never, runtime as never)
    expect(controller).not.toBeNull()
    const spawnController = controller as unknown as RuntimeSpawnController
    const spawned = await spawnController.spawn({
      cols: 80,
      rows: 24,
      worktreeId: 'wt-1',
      preAllocatedHandle: 'term_expected'
    })

    const spawnCall = spawnMock.mock.calls.at(-1)!
    const env = spawnCall[2].env as Record<string, string>
    expect(env.ORCA_TERMINAL_HANDLE).toBe('term_expected')
    expect(runtime.preAllocateHandleForPty).not.toHaveBeenCalled()
    expect(runtime.registerPreAllocatedHandleForPty).toHaveBeenCalledWith(
      expect.any(String),
      'term_expected'
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:spawned', {
      id: spawned.id
    })
  })
})
