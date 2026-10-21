import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { withDurableRuntimeStore } from '../runtime/runtime-durable-store-fixture'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers } from './pty/register-handlers'
import { setLocalPtyProvider } from './pty/provider/registry'
import {
  resetAgentLaunchPanesForTests,
  trackRunningAgentLaunchPane
} from '../agent-launch/agent-launch-pane-attachment'
import { AGENT_LAUNCH_PANE_REFUSED_CODE } from '../../shared/agent-launch-pane-verdict'

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

function localProvider(spawn: ReturnType<typeof vi.fn>): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test double carrying every provider member the spawn path calls; an unexpected call throws on the missing method.
  return {
    spawn,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    shutdown: vi.fn(),
    sendSignal: vi.fn(),
    getCwd: vi.fn(),
    getInitialCwd: vi.fn(),
    clearBuffer: vi.fn(),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(),
    getForegroundProcess: vi.fn(),
    serialize: vi.fn(),
    revive: vi.fn(),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {}),
    listProcesses: vi.fn(async () => []),
    attach: vi.fn(),
    getDefaultShell: vi.fn(),
    getProfiles: vi.fn()
  } as never
}

describe('a pane whose process belongs to an agent launch', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()
  const tabId = 'tab-agent-launch-early'
  const leafId = '55555555-5555-4555-8555-555555555555'
  const worktreeId = 'repo-1::/tmp/agent-launch-early'
  const paneKey = makePaneKey(tabId, leafId)
  const pane = { worktreeId, paneKey }

  afterEach(() => {
    resetAgentLaunchPanesForTests()
  })

  function mountPane(): Promise<unknown> {
    return Promise.resolve(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp/agent-launch-early',
        worktreeId,
        tabId,
        leafId,
        env: { ORCA_PANE_KEY: paneKey, ORCA_WORKTREE_ID: worktreeId }
      })
    )
  }

  /** Returns the runtime the spawn reports to. */
  function registerWithRuntime(providerSpawn: ReturnType<typeof vi.fn>) {
    setLocalPtyProvider(localProvider(providerSpawn))
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term_early'),
      registerPreAllocatedHandleForPty: vi.fn(),
      registerPty: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(),
      hasLiveTerminalForPaneKey: vi.fn(() => false),
      reportAgentLaunchPaneVerdict: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's window double, carrying the members a renderer spawn reaches.
    const window = mainWindow as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a runtime carrying only the members a renderer spawn reaches before it is refused or proceeds.
    const spawnRuntime = runtime as never
    registerPtyHandlers(window, spawnRuntime)
    return runtime
  }

  const PANE_ADDRESS = { worktreeId, tabId, leafId }

  it('waits for the launch instead of spawning while it runs, then tells the window it settled', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-after-launch' }))
    const runtime = registerWithRuntime(providerSpawn)
    const running = trackRunningAgentLaunchPane(pane)

    const mounted = mountPane()
    // An unblocked spawn settles well inside this window.
    const early = await Promise.race([
      mounted.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 1000))
    ])
    expect(early).toBe('waiting')
    expect(providerSpawn).not.toHaveBeenCalled()

    running.finish({ kind: 'proceed' })
    await expect(mounted).resolves.toMatchObject({ id: 'pty-after-launch' })
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'proceed'
    })
  })

  it('tells the window the launch failed, typed, instead of starting a shell', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-plain-shell' }))
    const runtime = registerWithRuntime(providerSpawn)
    const running = trackRunningAgentLaunchPane(pane)

    const mounted = mountPane()
    await new Promise<void>((resolve) => setImmediate(resolve))
    running.finish({ kind: 'not-started', code: 'agent_session_exited_during_start' })

    await expect(mounted).rejects.toThrow(AGENT_LAUNCH_PANE_REFUSED_CODE)
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'not-started',
      code: 'agent_session_exited_during_start'
    })
  })

  it("attaches once the launch's agent holds the pane, not once its prompt lands", async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-agent' }))
    const runtime = registerWithRuntime(providerSpawn)
    const running = trackRunningAgentLaunchPane(pane)

    const mounted = mountPane()
    // The agent runs here; its prompt is still being delivered.
    runtime.hasLiveTerminalForPaneKey.mockReturnValue(true)
    running.agentBound()

    await mounted.catch(() => {})
    expect(providerSpawn).toHaveBeenCalled()
    // Settled for the window: a later close reaches the launch through main's commit of it.
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'proceed'
    })
    running.finish({ kind: 'proceed' })
  })

  it('never offers a shell in a tab the host is taking back', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-plain-shell' }))
    const runtime = registerWithRuntime(providerSpawn)
    const running = trackRunningAgentLaunchPane(pane)

    const mounted = mountPane()
    running.finish({ kind: 'withdrawn' })

    await expect(mounted).rejects.toThrow(AGENT_LAUNCH_PANE_REFUSED_CODE)
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'withdrawn'
    })
  })
})

/** The daemon's three answers for a restored pane's binding, as `attachStablePaneOwner` reads them. */
const DAEMON_ANSWERS = [
  ['live: the agent survived, so the pane reattaches to it', 'live'],
  ['exited: the pane opens a fresh shell, as any tab does', 'exited'],
  ['daemon gone: the terminal host is unavailable, as for any tab', 'gone']
] as const

// What a launch pane is after a restart: nothing about its launch is restored, so it spawns as any pane.
describe('a restored pane after a restart', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  it.each(DAEMON_ANSWERS)('%s', async (_name, daemon) => {
    const worktreeId = 'repo-1::/tmp/launch-restart'
    const tabId = 'tab-launch-restart'
    const leafId = '89898989-8989-4989-8989-898989898989'
    const paneKey = makePaneKey(tabId, leafId)
    const providerSpawn = vi.fn(async (options: { attachOnly?: boolean }) => {
      if (!options.attachOnly) {
        return { id: 'pty-fresh-shell', incarnationId: 'inc-fresh' }
      }
      if (daemon === 'live') {
        return { id: 'pty-survived', incarnationId: 'inc-survived', isReattach: true }
      }
      throw daemon === 'exited'
        ? new SessionNotFoundError('pty-survived')
        : Object.assign(new Error('connect ECONNREFUSED'), {
            code: 'ECONNREFUSED',
            syscall: 'connect'
          })
    })
    setLocalPtyProvider(localProvider(providerSpawn))
    let session = {
      tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-survived' }] },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-survived' }
        }
      },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-survived' }
    }
    const store = withDurableRuntimeStore({
      getWorkspaceSession: vi.fn(() => session),
      setWorkspaceSession: vi.fn((next) => {
        session = next
      }),
      flushOrThrow: vi.fn(),
      persistPtyBinding: vi.fn(),
      getFolderWorkspace: vi.fn(() => undefined),
      getFolderWorkspaces: vi.fn(() => []),
      getProjectGroups: vi.fn(() => []),
      getRepos: vi.fn(() => [])
    })
    const runtime = {
      setPtyController: vi.fn(),
      resolveTerminalPane: vi.fn(() => {
        throw new Error('terminal_not_found')
      }),
      createPreAllocatedTerminalHandle: vi.fn(() => 'term-restart'),
      preAllocateHandleForPty: vi.fn(() => 'term-restart'),
      registerPreAllocatedHandleForPty: vi.fn(),
      beginPtyRegistration: vi.fn(),
      cancelPendingPtyRegistration: vi.fn(),
      assertPtyRegistrationAllowed: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      seedHeadlessTerminal: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(),
      hasLiveTerminalForPaneKey: vi.fn(() => false),
      reportAgentLaunchPaneVerdict: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's window double, carrying the members a renderer spawn reaches.
    const window = mainWindow as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a runtime and store carrying only the members a restored pane's spawn reaches.
    const [spawnRuntime, spawnStore] = [runtime as never, store as never]
    registerPtyHandlers(window, spawnRuntime, undefined, undefined, undefined, spawnStore)

    const mounted = Promise.resolve(
      handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp/launch-restart',
        worktreeId,
        tabId,
        leafId,
        env: { ORCA_PANE_KEY: paneKey, ORCA_TAB_ID: tabId, ORCA_WORKTREE_ID: worktreeId },
        // A pane that still carries its launch attaches to the agent it started, never plans again.
        ...(daemon === 'live'
          ? {
              agentLaunch: {
                launch: {
                  agent: 'claude',
                  target: { kind: 'existing', worktree: `id:${worktreeId}` }
                }
              }
            }
          : {})
      })
    )

    const ids = { live: 'pty-survived', exited: 'pty-fresh-shell' } as const
    await (daemon === 'gone'
      ? expect(mounted).rejects.toThrow('terminal_host_gone')
      : expect(mounted).resolves.toMatchObject({ id: ids[daemon] }))
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
  })
})
