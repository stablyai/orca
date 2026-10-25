import { ptyIncarnationById, ptyOwnership } from './provider/ownership-state'
import { createLaunchRaceRuntime } from '../pty-launch-race-test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentPaneLaunchRequest } from '../../../shared/agent-pane-launch-request'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import { statSyncMock } from '../pty-ipc-mock-registry'
import { registerPtyHandlers } from './register-handlers'
import {
  markAgentLaunchesClosedByUser,
  resetAgentLaunchPanesForTests
} from '../../agent-launch/agent-launch-pane-attachment'
import { AGENT_LAUNCH_PANE_REFUSED_CODE } from '../../../shared/agent-launch-pane-verdict'

vi.mock('electron', () => import('../pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('../pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node:fs/promises', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).fsPromisesModuleMock(await importOriginal())
)
vi.mock('node-pty', () => import('../pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('../pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('../pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('../pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('../pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('../pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('../pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

// An AI button's launch is planned inside its pane's spawn, with the host's planner, and writes no
// launch record.
describe('a pane that starts its own agent launch', () => {
  const { handlers, mainWindow, installDaemonTestProvider } = setupPtyIpcSuite()
  const tabId = 'tab-pane-launch'
  const leafId = '66666666-6666-4666-8666-666666666666'
  const worktreeId = 'repo-1::/tmp/pane-launch'
  const PANE_ADDRESS = { worktreeId, tabId, leafId }
  const AI_BUTTON: AgentPaneLaunchRequest = {
    launch: { agent: 'claude', target: { kind: 'existing', worktree: `id:${worktreeId}` } }
  }

  afterEach(() => {
    resetAgentLaunchPanesForTests()
    ptyIncarnationById.delete('pty-agent')
    ptyOwnership.delete('pty-agent')
  })

  function register(
    providerSpawn: ReturnType<typeof vi.fn>,
    plan: () => Promise<Record<string, unknown>> = async () => ({ command: 'claude' })
  ) {
    installDaemonTestProvider({ spawn: providerSpawn })
    const runtime = {
      ...createLaunchRaceRuntime(),
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_pane'),
      registerPreAllocatedHandleForPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(),
      hasLiveTerminalForPaneKey: vi.fn(() => false),
      reportAgentLaunchPaneVerdict: vi.fn(),
      showTerminalWorkspaceLaunchScope: vi.fn(async () => ({
        id: worktreeId,
        path: '/tmp/pane-launch',
        connectionId: null,
        repo: null,
        folderWorkspace: null
      })),
      planAgentPaneLaunch: vi.fn(plan),
      getTerminalHandleForPaneKey: vi.fn(() => null),
      closeTerminal: vi.fn(async () => ({}))
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's window double, carrying the members a renderer spawn reaches.
    const window = mainWindow as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a runtime carrying only the members a pane's own launch reaches.
    const spawnRuntime = runtime as never
    registerPtyHandlers(window, spawnRuntime)
    return runtime
  }

  function spawnPane(
    agentLaunch: AgentPaneLaunchRequest = AI_BUTTON,
    pane: Record<string, unknown> = {}
  ): Promise<unknown> {
    return Promise.resolve(
      handlers.get('pty:spawn')!(null, {
        cols: 132,
        rows: 40,
        cwd: '/tmp/pane-launch',
        worktreeId,
        tabId,
        leafId,
        command: '',
        agentLaunch,
        ...pane
      })
    )
  }

  it("starts the host's planned command once, at the pane's size, and says it started", async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-agent' }))
    const runtime = register(providerSpawn)

    await expect(spawnPane()).resolves.toMatchObject({ id: 'pty-agent' })

    expect(runtime.planAgentPaneLaunch).toHaveBeenCalledOnce()
    expect(providerSpawn).toHaveBeenCalledOnce()
    expect(providerSpawn).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'claude', cols: 132, rows: 40 })
    )
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'proceed'
    })
  })

  // Why: the window submits a handoff into this pane, and Enter picks Codex's "Update now" (#18153).
  it('plans a pane whose prompt the window submits without the startup update prompt', async () => {
    const runtime = register(vi.fn(async () => ({ id: 'pty-agent' })))

    await spawnPane({ ...AI_BUTTON, suppressStartupUpdatePrompt: true })

    expect(runtime.planAgentPaneLaunch).toHaveBeenCalledWith(
      worktreeId,
      expect.objectContaining({ startupAgent: 'claude', suppressStartupUpdatePrompt: true })
    )
  })

  // Planned command quoting requires the planner's runtime shell; an inferred tab shell can reject WSL-share repos.
  it("runs the plan's runtime shell, not the tab's, as a host launch does", async () => {
    const providerSpawn = vi.fn(async (_options: { shellOverride?: string }) => ({
      id: 'pty-agent'
    }))
    const runtime = register(providerSpawn, async () => ({
      command: 'claude',
      launchRuntime: {
        platform: process.platform,
        pty: { shellOverride: '/bin/planned-shell', terminalWindowsWslDistro: null }
      }
    }))

    await spawnPane(AI_BUTTON, { shellOverride: 'cmd.exe' })

    expect(runtime.planAgentPaneLaunch).toHaveBeenCalledWith(
      worktreeId,
      expect.not.objectContaining({ shellOverride: expect.anything() })
    )
    expect(providerSpawn.mock.calls[0]?.[0].shellOverride).toBe('/bin/planned-shell')
  })

  // Orchestration callers, hook evidence and title presence read the launch's token off its PTY.
  it("gives the agent its launch token and agent identity, as the host's own launch did", async () => {
    const providerSpawn = vi.fn(async (_options: { env?: Record<string, string> }) => ({
      id: 'pty-agent',
      incarnationId: 'inc-1'
    }))
    const runtime = register(providerSpawn, async () => ({
      command: 'claude',
      launchAgent: 'claude',
      launchConfig: { agentArgs: '', agentEnv: {} }
    }))

    await spawnPane()

    const env = providerSpawn.mock.calls[0]?.[0]?.env ?? {}
    expect(env.ORCA_AGENT_LAUNCH_TOKEN).toMatch(/.+/)
    expect(JSON.stringify(runtime.registerPty.mock.calls)).toContain(
      JSON.stringify({ launchToken: env.ORCA_AGENT_LAUNCH_TOKEN, launchAgent: 'claude' })
    )
  })

  it('starts an agent in the workspace root when its folder is gone, and says so', async () => {
    const missing = '/tmp/pane-launch/deleted'
    statSyncMock.mockImplementation((target: string) => {
      if (target === missing) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return { isDirectory: () => true, mode: 0o755 }
    })
    const providerSpawn = vi.fn(async (_options: { cwd?: string }) => ({
      id: 'pty-agent',
      startupCwdSource: 'request' as const
    }))
    register(providerSpawn)

    const result = await spawnPane(AI_BUTTON, { cwd: missing })

    expect(providerSpawn.mock.calls[0]?.[0].cwd).toBe('/tmp/pane-launch')
    expect(result).toMatchObject({
      startupCwdFallback: { kind: 'worktree', cwd: '/tmp/pane-launch' }
    })
  })

  it('starts one agent when the pane spawns twice at once', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-agent' }))
    register(providerSpawn)

    await Promise.all([spawnPane(), spawnPane()])

    expect(providerSpawn).toHaveBeenCalledOnce()
  })

  it('starts no shell when the plan fails, and the pane says why', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-shell' }))
    const runtime = register(providerSpawn, async () => {
      throw new Error('agent_launch_agent_disabled')
    })

    await expect(spawnPane()).rejects.toThrow(AGENT_LAUNCH_PANE_REFUSED_CODE)

    expect(providerSpawn).not.toHaveBeenCalled()
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'not-started',
      code: 'agent_launch_agent_disabled'
    })
  })

  it('cannot confirm a start whose provider answer was lost', async () => {
    const providerSpawn = vi.fn(async () => {
      throw new Error('daemon reply lost')
    })
    const runtime = register(providerSpawn)

    await expect(spawnPane()).rejects.toThrow(AGENT_LAUNCH_PANE_REFUSED_CODE)

    expect(providerSpawn).toHaveBeenCalledOnce()
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'unconfirmed'
    })
  })

  it('starts nothing when the user closed the pane while it was planned', async () => {
    let releasePlan!: () => void
    const providerSpawn = vi.fn(async () => ({ id: 'pty-agent' }))
    const runtime = register(
      providerSpawn,
      () =>
        new Promise((done) => {
          releasePlan = () => done({ command: 'claude' })
        })
    )

    const spawned = spawnPane()
    await vi.waitFor(() => expect(runtime.planAgentPaneLaunch).toHaveBeenCalled())
    markAgentLaunchesClosedByUser(worktreeId, { kind: 'pane', tabId, leafId })
    releasePlan()

    await expect(spawned).rejects.toThrow('agent_launch_tab_closed')
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
  })
})
