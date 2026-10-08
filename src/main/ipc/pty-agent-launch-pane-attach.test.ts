import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'
import {
  resetAgentLaunchPanesForTests,
  trackRunningAgentLaunchPane
} from '../agent-launch/agent-launch-pane-attachment'
import {
  pendingAgentSessionOperationRow,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import {
  AGENT_LAUNCH_PANE_REFUSED_CODE,
  type AgentLaunchPaneOutcome
} from '../../shared/agent-launch-pane-verdict'

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

  function recorded(outcome: AgentSessionOperationOutcome): AgentSessionOperationRow {
    return {
      ...pendingAgentSessionOperationRow({
        callerKey: 'caller',
        operationId: `${Date.now()}-${'1'.padStart(32, '0')}`,
        fingerprint: 'fp',
        now: Date.now()
      }),
      outcome,
      ownedPane: pane
    }
  }

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

  type LaunchPaneOnTab = { leafId: string; outcome?: AgentLaunchPaneOutcome }

  /** `rows` is the launch record; null models a process that has not opened it yet. `onTab` is
   *  what the restored tab keeps about its pane's launch. Returns the runtime the spawn reports to. */
  function registerWithRuntime(
    providerSpawn: ReturnType<typeof vi.fn>,
    record: { rows: AgentSessionOperationRow[] | null; onTab?: LaunchPaneOnTab }
  ) {
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
      openedAgentSessionRecordStore: vi.fn(() =>
        record.rows ? { listOperationRowsOwningPane: () => record.rows } : null
      ),
      openAgentSessionRecordStore: vi.fn(async () => ({
        listOperationRowsOwningPane: () => record.rows ?? [recorded({ status: 'unknown' })]
      })),
      reportAgentLaunchPaneVerdict: vi.fn()
    }
    // The persisted session as a restart restores it.
    const store = record.onTab
      ? {
          getWorkspaceSession: () => ({
            tabsByWorktree: { [worktreeId]: [{ id: tabId, agentLaunchPane: record.onTab }] }
          })
        }
      : undefined
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's window double, carrying the members a renderer spawn reaches.
    const window = mainWindow as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a runtime carrying only the members a renderer spawn reaches before it is refused or proceeds.
    const spawnRuntime = runtime as never
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a store carrying only the persisted session the launch pane's spawn reads.
    const spawnStore = store as never
    registerPtyHandlers(window, spawnRuntime, undefined, undefined, undefined, spawnStore)
    return runtime
  }

  const PANE_ADDRESS = { worktreeId, tabId, leafId }

  it('waits for the launch instead of spawning while it runs, then tells the window it settled', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-after-launch' }))
    const rows: AgentSessionOperationRow[] = []
    const runtime = registerWithRuntime(providerSpawn, { rows })
    const running = trackRunningAgentLaunchPane(pane)

    const mounted = mountPane()
    // An unblocked spawn settles well inside this window.
    const early = await Promise.race([
      mounted.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waiting'), 1000))
    ])
    expect(early).toBe('waiting')
    expect(providerSpawn).not.toHaveBeenCalled()

    rows.push(
      recorded({
        status: 'succeeded',
        sessionId: '',
        launch: {
          outcome: { kind: 'terminal', handle: 'term_1', paneKey },
          worktreeId,
          receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: '' }
        }
      })
    )
    running.finish({ tabTakenBack: false })
    await expect(mounted).resolves.toMatchObject({ id: 'pty-after-launch' })
    // Settled: the tab forgets the launch, so a restart never opens the record for this pane.
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'proceed'
    })
  })

  it('tells the window the launch failed, typed, instead of starting a shell', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-plain-shell' }))
    const rows: AgentSessionOperationRow[] = []
    const runtime = registerWithRuntime(providerSpawn, { rows })
    const running = trackRunningAgentLaunchPane(pane)

    const mounted = mountPane()
    await new Promise<void>((resolve) => setImmediate(resolve))
    rows.push(recorded({ status: 'failed', code: 'agent_session_exited_during_start' }))
    running.finish({ tabTakenBack: false })

    await expect(mounted).rejects.toThrow(AGENT_LAUNCH_PANE_REFUSED_CODE)
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'not-started',
      code: 'agent_session_exited_during_start'
    })
  })

  it('still refuses a shell to a pane that mounts after the launch failed', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-plain-shell' }))
    registerWithRuntime(providerSpawn, {
      rows: [recorded({ status: 'failed', code: 'agent_not_installed' })]
    })

    await expect(mountPane()).rejects.toThrow(AGENT_LAUNCH_PANE_REFUSED_CODE)
    expect(providerSpawn).not.toHaveBeenCalled()
  })

  it('after a restart, a pane whose launch was still open reads the record before it starts anything', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-plain-shell' }))
    const runtime = registerWithRuntime(providerSpawn, { rows: null, onTab: { leafId } })

    await expect(mountPane()).rejects.toThrow(AGENT_LAUNCH_PANE_REFUSED_CODE)
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'unconfirmed'
    })
  })

  it('after a restart, a pane whose fate the tab keeps says it again without opening the record', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-plain-shell' }))
    const runtime = registerWithRuntime(providerSpawn, {
      rows: null,
      onTab: { leafId, outcome: { kind: 'not-started', code: 'agent_not_installed' } }
    })

    await expect(mountPane()).rejects.toThrow(AGENT_LAUNCH_PANE_REFUSED_CODE)
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
  })

  it('a new launch into a pane that showed "couldn\'t confirm" lets it attach to the new agent', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-new-agent' }))
    const rows: AgentSessionOperationRow[] = []
    // The saved tab still says an earlier launch could not be confirmed.
    const runtime = registerWithRuntime(providerSpawn, {
      rows,
      onTab: { leafId, outcome: { kind: 'unconfirmed' } }
    })
    const running = trackRunningAgentLaunchPane(pane)

    // The remounted pane spawns while the new launch runs: it waits, it does not show the old notice.
    const mounted = mountPane()
    rows.push(
      recorded({
        status: 'succeeded',
        sessionId: '',
        launch: {
          outcome: { kind: 'terminal', handle: 'term_1', paneKey },
          worktreeId,
          receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: '' }
        }
      })
    )
    running.finish({ tabTakenBack: false })

    // Past the verdict the ordinary spawn path runs (this suite's store double saves nothing).
    await mounted.catch(() => {})
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'proceed'
    })
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'unconfirmed'
    })
    expect(providerSpawn).toHaveBeenCalled()
  })

  it("attaches once the launch's agent holds the pane, not once its prompt lands", async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-agent' }))
    const runtime = registerWithRuntime(providerSpawn, { rows: [] })
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
    running.finish({ tabTakenBack: false })
  })

  it('after a restart, a settled launch pane spawns as any pane does, without opening the record', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-ordinary' }))
    const runtime = registerWithRuntime(providerSpawn, { rows: null })

    await expect(mountPane()).resolves.toMatchObject({ id: 'pty-ordinary' })
    expect(runtime.openAgentSessionRecordStore).not.toHaveBeenCalled()
    expect(runtime.reportAgentLaunchPaneVerdict).not.toHaveBeenCalled()
  })

  it('never offers a shell in a tab the host is taking back', async () => {
    const providerSpawn = vi.fn(async () => ({ id: 'pty-plain-shell' }))
    const runtime = registerWithRuntime(providerSpawn, { rows: [] })
    const running = trackRunningAgentLaunchPane(pane)

    const mounted = mountPane()
    running.finish({ tabTakenBack: true })

    await expect(mounted).rejects.toThrow(AGENT_LAUNCH_PANE_REFUSED_CODE)
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(runtime.reportAgentLaunchPaneVerdict).toHaveBeenCalledWith(PANE_ADDRESS, {
      kind: 'withdrawn'
    })
  })
})
