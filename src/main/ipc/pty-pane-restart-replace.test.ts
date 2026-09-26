import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite, type PtyIpcSuiteFixtures } from './pty-ipc-test-harness'
import { SessionNotFoundError } from '../daemon/daemon-errors'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

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

const worktreeId = 'repo-1::/tmp/restart'
const cwd = '/tmp/restart'
const tabId = 'tab-restart'
const leafId = '12121212-1212-4212-8212-121212121212'
const paneKey = makePaneKey(tabId, leafId)

type RestartHarness = ReturnType<typeof installRestartHarness>

function registerWithFakes(
  mainWindow: PtyIpcSuiteFixtures['mainWindow'],
  runtime: RestartHarness['runtime'],
  store: RestartHarness['store']
): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spawn and kill read only the window, runtime and store members these fakes define.
  const args = [
    mainWindow,
    runtime,
    undefined,
    undefined,
    undefined,
    store
  ] as unknown as Parameters<typeof registerPtyHandlers>
  registerPtyHandlers(...args)
}

function installRestartHarness(
  options: { shutdownFails?: boolean; shutdownGate?: Promise<void> } = {}
) {
  let oldSessionAlive = true
  const control = { shutdownFails: options.shutdownFails ?? false }
  const providerSpawn = vi.fn(async (spawnOptions: { attachOnly?: boolean }) => {
    if (!spawnOptions.attachOnly) {
      return { id: 'pty-new', incarnationId: 'inc-new' }
    }
    if (!oldSessionAlive) {
      throw new SessionNotFoundError('pty-old')
    }
    return { id: 'pty-old', incarnationId: 'inc-old', isReattach: true }
  })
  const shutdown = vi.fn(async () => {
    await options.shutdownGate
    if (control.shutdownFails) {
      throw new Error('daemon unreachable')
    }
    oldSessionAlive = false
  })
  const provider = {
    spawn: providerSpawn,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    shutdown,
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
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the restart path calls only the provider members this fake defines.
  setLocalPtyProvider(provider as unknown as Parameters<typeof setLocalPtyProvider>[0])
  let session = {
    tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId, ptyId: 'pty-old' }] },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf' as const, leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: 'pty-old' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-old' }
  }
  const store = {
    getWorkspaceSession: vi.fn(() => session),
    setWorkspaceSession: vi.fn((next) => {
      session = next
    }),
    flushOrThrow: vi.fn(),
    runDurableMutation: vi.fn(async <T>(mutate: () => { value: T }) => mutate().value),
    persistPtyBinding: vi.fn(),
    getFolderWorkspace: vi.fn(() => undefined),
    getFolderWorkspaces: vi.fn(() => []),
    getProjectGroups: vi.fn(() => []),
    getRepos: vi.fn(() => [])
  }
  const runtime = {
    setPtyController: vi.fn(),
    resolveTerminalPane: vi.fn(() => {
      throw new Error('terminal_not_found')
    }),
    markPtyStopRequested: vi.fn(),
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
    onPtyData: vi.fn()
  }
  return { providerSpawn, shutdown, store, runtime, control }
}

function restartSpawnArgs(extra: { replacesPtyId?: string } = {}) {
  return {
    cols: 80,
    rows: 24,
    cwd,
    command: 'codex',
    launchAgent: 'codex',
    worktreeId,
    tabId,
    leafId,
    env: { ORCA_PANE_KEY: paneKey, ORCA_TAB_ID: tabId, ORCA_WORKTREE_ID: worktreeId },
    ...extra
  }
}

describe('pty:spawn replacing a pane owner', () => {
  const { handlers, mainWindow } = setupPtyIpcSuite()

  function exitPayloads(id: string): Record<string, unknown>[] {
    return mainWindow.webContents.send.mock.calls
      .filter(([channel, payload]) => channel === 'pty:exit' && payload?.id === id)
      .map(([, payload]) => payload)
  }

  it('reattaches a live pane owner when the spawn does not name it as replaced', async () => {
    const { providerSpawn, store, runtime } = installRestartHarness()
    registerWithFakes(mainWindow, runtime, store)

    const spawned = await handlers.get('pty:spawn')!(null, restartSpawnArgs())

    expect(spawned).toMatchObject({ id: 'pty-old', isReattach: true })
    expect(providerSpawn).toHaveBeenCalledTimes(1)
  })

  it('stops the replaced owner and launches fresh instead of reattaching it', async () => {
    const { providerSpawn, shutdown, store, runtime } = installRestartHarness()
    registerWithFakes(mainWindow, runtime, store)

    const spawned = await handlers.get('pty:spawn')!(
      null,
      restartSpawnArgs({ replacesPtyId: 'pty-old' })
    )

    expect(spawned).toMatchObject({ id: 'pty-new' })
    expect(shutdown).toHaveBeenCalledWith('pty-old', expect.objectContaining({ immediate: true }))
    expect(spawned).not.toHaveProperty('isReattach', true)
    const freshLaunch = providerSpawn.mock.calls.find(([options]) => !options.attachOnly)?.[0]
    expect(freshLaunch).toMatchObject({ command: 'codex' })
    expect(shutdown.mock.invocationCallOrder[0]).toBeLessThan(
      providerSpawn.mock.invocationCallOrder[0]!
    )
  })

  it('labels the replaced owner exit so the renderer keeps the pane', async () => {
    const { store, runtime } = installRestartHarness()
    registerWithFakes(mainWindow, runtime, store)

    await handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))

    expect(exitPayloads('pty-old')).toEqual([
      expect.objectContaining({ id: 'pty-old', replacedByRestart: true })
    ])
  })

  it('never labels an ordinary close', async () => {
    const { store, runtime } = installRestartHarness()
    registerWithFakes(mainWindow, runtime, store)

    await handlers.get('pty:kill')!(null, { id: 'pty-old' })

    expect(exitPayloads('pty-old')).toHaveLength(1)
    expect(exitPayloads('pty-old')[0]).not.toHaveProperty('replacedByRestart')
  })

  it('hands a spawn for the pane that arrives mid-stop the replacement, not the dying owner', async () => {
    let finishShutdown!: () => void
    const shutdownGate = new Promise<void>((resolve) => {
      finishShutdown = resolve
    })
    const { providerSpawn, shutdown, store, runtime } = installRestartHarness({ shutdownGate })
    registerWithFakes(mainWindow, runtime, store)

    const restart = handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledTimes(1))
    // A hidden tab revealed now reconnects its pane while the old owner is still alive.
    const reveal = handlers.get('pty:spawn')!(null, restartSpawnArgs())
    finishShutdown()

    await expect(restart).resolves.toMatchObject({ id: 'pty-new' })
    await expect(reveal).resolves.toMatchObject({ id: 'pty-new', isReattach: true })
    expect(providerSpawn.mock.calls.filter(([options]) => !options.attachOnly)).toHaveLength(1)
  })

  it('refuses to launch a second process when the replaced owner could not be stopped', async () => {
    const { providerSpawn, store, runtime, control } = installRestartHarness({
      shutdownFails: true
    })
    registerWithFakes(mainWindow, runtime, store)

    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).rejects.toThrow('daemon unreachable')
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(exitPayloads('pty-old')).toEqual([])
    // The pane is released: a later spawn still reaches the surviving owner instead of hanging.
    await expect(handlers.get('pty:spawn')!(null, restartSpawnArgs())).resolves.toMatchObject({
      id: 'pty-old',
      isReattach: true
    })
    // The failed restart left no label behind: a later close of the same PTY reads as a close.
    control.shutdownFails = false
    await handlers.get('pty:kill')!(null, { id: 'pty-old' })
    expect(exitPayloads('pty-old')).toHaveLength(1)
    expect(exitPayloads('pty-old')[0]).not.toHaveProperty('replacedByRestart')
  })
})
