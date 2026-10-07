import { PtyBindingPersistenceOperations } from '../persistence/loading-store/pty-binding-persistence'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { setupPtyIpcSuite, type PtyIpcSuiteFixtures } from './pty-ipc-test-harness'
import { registerSshPtyProvider, unregisterSshPtyProvider } from './pty/provider/registry'
import { toAppSshPtyId } from '../providers/ssh-pty-id'
import { TerminalKilledError } from '../daemon/daemon-pty-lifecycle-errors'
import { makePaneKey } from '../../shared/stable-pane-id'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'
import { TerminalIntentionalStops } from '../runtime/terminal-intentional-stops'

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
type FakeSession = {
  tabsByWorktree: Record<string, { id: string; worktreeId: string; ptyId: string | null }[]>
  terminalLayoutsByTabId: Record<
    string,
    {
      root: { type: 'leaf'; leafId: string }
      activeLeafId: string
      expandedLeafId: null
      ptyIdsByLeafId: Record<string, string>
    }
  >
  terminalPtyIncarnationsByPaneKey: Record<string, string>
}

function seedSession(ptyId: string): FakeSession {
  return {
    tabsByWorktree: { [worktreeId]: [{ id: tabId, worktreeId, ptyId }] },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [paneKey]: 'inc-old' }
  }
}

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
  const control = { shutdownFails: options.shutdownFails ?? false, failNextWrite: false }
  const boundAtFreshLaunch: (string | undefined)[] = []
  const providerSpawn = vi.fn(async (spawnOptions: { attachOnly?: boolean }) => {
    if (!spawnOptions.attachOnly) {
      boundAtFreshLaunch.push(leafBinding())
      return { id: 'pty-new', incarnationId: 'inc-new' }
    }
    if (!oldSessionAlive) {
      throw new TerminalKilledError('pty-old')
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
  let session = seedSession('pty-old')
  const store = {
    isRuntimeWorkspaceSessionRetired: vi.fn(() => false),
    getWorkspaceSession: vi.fn((_hostId?: string): FakeSession => session),
    setWorkspaceSession: vi.fn((next) => {
      session = next
    }),
    flushOrThrow: vi.fn(),
    runDurableMutation: vi.fn(
      async <T>(
        mutate: () => { value: T; persist?: boolean | 'if-dirty'; rollback?: () => void }
      ) => {
        const mutation = mutate()
        if (mutation.persist !== false) {
          if (control.failNextWrite) {
            control.failNextWrite = false
            mutation.rollback?.()
            throw new Error('save failed')
          }
          durableBindings.push(leafBinding())
        }
        return mutation.value
      }
    ),
    getWorkspaceSessionHostIds: vi.fn(() => [
      'local',
      ...Object.keys(state.workspaceSessionsByHostId)
    ]),
    getFolderWorkspace: vi.fn(() => undefined),
    getFolderWorkspaces: vi.fn(() => []),
    getProjectGroups: vi.fn(() => []),
    getRepos: vi.fn(() => [])
  }
  const state: {
    workspaceSession: FakeSession
    workspaceSessionsByHostId: Record<string, FakeSession>
  } = { workspaceSession: session, workspaceSessionsByHostId: {} }
  const durableBindings: (string | undefined)[] = []
  function leafBinding(hostId?: string): string | undefined {
    return store.getWorkspaceSession(hostId).terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[leafId]
  }
  // Like the store, a missing host partition reads as an empty session, never the local one.
  store.getWorkspaceSession.mockImplementation((hostId?: string) =>
    hostId && hostId !== 'local'
      ? (state.workspaceSessionsByHostId[hostId] ?? {
          tabsByWorktree: {},
          terminalLayoutsByTabId: {},
          terminalPtyIncarnationsByPaneKey: {}
        })
      : state.workspaceSession
  )
  const bindingRuntime = {
    state,
    dirtyProfileStateDomains: new Set(),
    runDurableMutation: store.runDurableMutation,
    writeTimer: null,
    pendingWrite: null,
    quitFlushStarted: false,
    writeGeneration: 0,
    lastDurableWriteGeneration: 0
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: binding writes read only state, write bookkeeping, durable mutation and the session partitions from these fakes.
  const bindingArgs = [bindingRuntime, store] as unknown as ConstructorParameters<
    typeof PtyBindingPersistenceOperations
  >
  const bindingOperations = new PtyBindingPersistenceOperations(...bindingArgs)
  const storeWithRetirement = Object.assign(store, {
    persistPtyBinding: vi.fn(bindingOperations.persistPtyBinding.bind(bindingOperations)),
    retirePtyBinding: bindingOperations.retirePtyBinding.bind(bindingOperations)
  })
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
    onPtyData: vi.fn(),
    intentionalPtyStops: new TerminalIntentionalStops()
  }
  return {
    providerSpawn,
    shutdown,
    store: storeWithRetirement,
    runtime,
    control,
    provider,
    leafBinding,
    durableBindings,
    boundAtFreshLaunch,
    partitions: state.workspaceSessionsByHostId
  }
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
  it('swaps the stopped binding for the replacement in one write, never unbinding the pane', async () => {
    const { providerSpawn, store, runtime, durableBindings, boundAtFreshLaunch } =
      installRestartHarness()
    const session = store.getWorkspaceSession()
    const layout = structuredClone(session.terminalLayoutsByTabId[tabId])
    registerWithFakes(mainWindow, runtime, store)
    await handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    const swapped = store.getWorkspaceSession()
    expect(boundAtFreshLaunch).toEqual(['pty-old'])
    expect(durableBindings).toEqual(['pty-new'])
    expect(swapped.tabsByWorktree[worktreeId]).toEqual([
      { ...session.tabsByWorktree[worktreeId][0], ptyId: 'pty-new' }
    ])
    expect(swapped.terminalLayoutsByTabId[tabId]).toEqual({
      ...layout,
      ptyIdsByLeafId: { [leafId]: 'pty-new' }
    })
    expect(swapped.terminalPtyIncarnationsByPaneKey).toEqual({ [paneKey]: 'inc-new' })
    expect(providerSpawn.mock.calls.every(([options]) => !options.attachOnly)).toBe(true)
  })

  it('launches fresh when a stale snapshot re-publishes the stopped binding mid-spawn', async () => {
    const { providerSpawn, store, runtime, leafBinding } = installRestartHarness()
    runtime.createPreAllocatedTerminalHandle.mockImplementationOnce(() => {
      // A debounced renderer layout patch still carrying the old id lands after the stop.
      const current = store.getWorkspaceSession()
      current.terminalLayoutsByTabId[tabId] = {
        ...current.terminalLayoutsByTabId[tabId],
        ptyIdsByLeafId: { [leafId]: 'pty-old' }
      }
      return 'term-restart'
    })
    registerWithFakes(mainWindow, runtime, store)
    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).resolves.toMatchObject({ id: 'pty-new' })
    expect(runtime.createPreAllocatedTerminalHandle).toHaveBeenCalled()
    expect(providerSpawn.mock.calls.every(([options]) => !options.attachOnly)).toBe(true)
    expect(leafBinding()).toBe('pty-new')
  })

  it('swaps a binding the renderer withdrew before connecting the replacement', async () => {
    const { providerSpawn, store, runtime, leafBinding } = installRestartHarness()
    runtime.createPreAllocatedTerminalHandle.mockImplementationOnce(() => {
      // A split tab's partial layout map, or an SSH terminated lease, lets the renderer clear land.
      delete store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId]
      return 'term-restart'
    })
    registerWithFakes(mainWindow, runtime, store)
    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).resolves.toMatchObject({ id: 'pty-new' })
    expect(providerSpawn.mock.calls.every(([options]) => !options.attachOnly)).toBe(true)
    expect(leafBinding()).toBe('pty-new')
  })

  it('clears the stopped binding when the replacement fails, so the remount starts fresh', async () => {
    const { providerSpawn, store, runtime, leafBinding } = installRestartHarness()
    providerSpawn.mockRejectedValueOnce(new Error('spawn failed'))
    registerWithFakes(mainWindow, runtime, store)
    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).rejects.toThrow('spawn failed')
    const boundAfterFailure = leafBinding()
    // The renderer's recovery remount sends no replacesPtyId.
    await expect(handlers.get('pty:spawn')!(null, restartSpawnArgs())).resolves.toMatchObject({
      id: 'pty-new'
    })
    expect(boundAfterFailure).toBeUndefined()
    expect(providerSpawn.mock.calls.every(([options]) => !options.attachOnly)).toBe(true)
  })

  it('reaps the replacement when its binding save fails, and the remount starts fresh', async () => {
    const { provider, providerSpawn, store, runtime, control, leafBinding } =
      installRestartHarness()
    control.failNextWrite = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    registerWithFakes(mainWindow, runtime, store)
    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).rejects.toThrow('ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED')
    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-new',
      expect.objectContaining({ immediate: true })
    )
    const boundAfterFailure = leafBinding()
    await expect(handlers.get('pty:spawn')!(null, restartSpawnArgs())).resolves.toMatchObject({
      id: 'pty-new'
    })
    expect(boundAfterFailure).toBeUndefined()
    expect(providerSpawn.mock.calls.every(([options]) => !options.attachOnly)).toBe(true)
  })

  it('refuses an old restart after another owner has already claimed the pane', async () => {
    const { shutdown, providerSpawn, store, runtime } = installRestartHarness()
    store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId] = 'successor'
    registerWithFakes(mainWindow, runtime, store)
    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).rejects.toThrow('terminal_pane_owner_changed')
    expect(shutdown).not.toHaveBeenCalled()
    expect(providerSpawn).not.toHaveBeenCalled()
    expect(store.setWorkspaceSession).not.toHaveBeenCalled()
  })

  it('reaps the replacement when a successor binds the pane during its spawn', async () => {
    const { provider, providerSpawn, store, runtime, leafBinding } = installRestartHarness()
    providerSpawn.mockImplementationOnce(async () => {
      store.getWorkspaceSession().terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId] = 'successor'
      return { id: 'pty-new', incarnationId: 'inc-new' }
    })
    registerWithFakes(mainWindow, runtime, store)
    await expect(
      handlers.get('pty:spawn')!(null, restartSpawnArgs({ replacesPtyId: 'pty-old' }))
    ).rejects.toThrow('terminal_pane_owner_changed')
    expect(provider.shutdown).toHaveBeenCalledWith(
      'pty-new',
      expect.objectContaining({ immediate: true })
    )
    expect(leafBinding()).toBe('successor')
  })

  /** The SSH pane lives only in its host partition; the local leaf keeps an unrelated id. */
  async function withSshRestart(
    run: (
      host: RestartHarness & { oldId: string; newId: string; hostId: string },
      restart: (extra?: { replacesPtyId?: string }) => Promise<unknown>
    ) => Promise<void>
  ): Promise<void> {
    const harness = installRestartHarness()
    const connectionId = 'restart-ssh'
    const hostId = 'ssh:restart-ssh'
    const oldId = toAppSshPtyId(connectionId, 'pty-old')
    const newId = toAppSshPtyId(connectionId, 'pty-new')
    harness.partitions[hostId] = seedSession(oldId)
    Object.assign(harness.store, {
      markSshRemotePtyLease: vi.fn(),
      upsertSshRemotePtyLease: vi.fn(),
      removeSshRemotePtyLease: vi.fn(),
      supersedeSshRemotePtyLeasesForBoundPane: vi.fn()
    })
    let oldAlive = true
    harness.shutdown.mockImplementation(async () => {
      oldAlive = false
    })
    harness.providerSpawn.mockImplementation(async (options) => {
      if (!options.attachOnly) {
        return { id: newId, incarnationId: 'inc-new' }
      }
      if (!oldAlive) {
        throw new TerminalKilledError(oldId)
      }
      return { id: oldId, incarnationId: 'inc-old', isReattach: true }
    })
    registerSshPtyProvider(
      connectionId,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same fake provider surface used by the local restart fixture.
      harness.provider as unknown as Parameters<typeof registerSshPtyProvider>[1]
    )
    const localSpawn = vi.fn(() => {
      throw new Error('wrong execution host')
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test must never reach the local provider.
    setLocalPtyProvider({
      ...harness.provider,
      spawn: localSpawn,
      shutdown: localSpawn
    } as unknown as Parameters<typeof setLocalPtyProvider>[0])
    registerWithFakes(mainWindow, harness.runtime, harness.store)
    try {
      await run({ ...harness, oldId, newId, hostId }, async (extra = {}) =>
        handlers.get('pty:spawn')!(null, { ...restartSpawnArgs(extra), connectionId })
      )
      expect(localSpawn).not.toHaveBeenCalled()
      expect(harness.leafBinding()).toBe('pty-old')
    } finally {
      unregisterSshPtyProvider(connectionId)
    }
  }

  it('swaps the direct-SSH host binding without touching the local provider', async () => {
    await withSshRestart(async (host, restart) => {
      await expect(restart({ replacesPtyId: host.oldId })).resolves.toMatchObject({
        id: host.newId
      })
      expect(host.shutdown).toHaveBeenCalledWith(
        host.oldId,
        expect.objectContaining({ immediate: true })
      )
      expect(host.store.persistPtyBinding).toHaveBeenCalledWith(expect.any(Function), host.hostId)
      expect(host.leafBinding(host.hostId)).toBe(host.newId)
      expect(host.providerSpawn.mock.calls.every(([options]) => !options.attachOnly)).toBe(true)
    })
  })

  it('reaps a direct-SSH replacement when a successor binds the host pane during its spawn', async () => {
    await withSshRestart(async (host, restart) => {
      host.providerSpawn.mockImplementationOnce(async () => {
        host.partitions[host.hostId].terminalLayoutsByTabId[tabId].ptyIdsByLeafId[leafId] =
          'successor'
        return { id: host.newId, incarnationId: 'inc-new' }
      })
      await expect(restart({ replacesPtyId: host.oldId })).rejects.toThrow(
        'terminal_pane_owner_changed'
      )
      expect(host.shutdown).toHaveBeenCalledWith(
        host.newId,
        expect.objectContaining({ immediate: true })
      )
      expect(host.leafBinding(host.hostId)).toBe('successor')
    })
  })

  it('clears the direct-SSH stopped binding when the replacement fails, so the remount starts fresh', async () => {
    await withSshRestart(async (host, restart) => {
      host.providerSpawn.mockRejectedValueOnce(new Error('spawn failed'))
      await expect(restart({ replacesPtyId: host.oldId })).rejects.toThrow('spawn failed')
      const boundAfterFailure = host.leafBinding(host.hostId)
      await expect(restart()).resolves.toMatchObject({ id: host.newId })
      expect(boundAfterFailure).toBeUndefined()
      expect(host.providerSpawn.mock.calls.every(([options]) => !options.attachOnly)).toBe(true)
    })
  })

  it.each(['darwin', 'linux', 'win32'])(
    'restarts a folder workspace on %s without deleting its pane',
    async (platform) => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      onTestFinished(() => {
        Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
      })
      const { store, runtime, leafBinding } = installRestartHarness()
      const folderId = 'folder:restart-folder'
      const session = store.getWorkspaceSession()
      session.tabsByWorktree[folderId] = session.tabsByWorktree[worktreeId].map((tab) => ({
        ...tab,
        worktreeId: folderId
      }))
      session.tabsByWorktree[worktreeId] = []
      const folder = {
        id: 'restart-folder',
        folderPath: process.cwd(),
        name: 'Restart',
        projectGroupId: null
      }
      Object.assign(store, {
        getFolderWorkspaces: vi.fn(() => [folder]),
        getFolderWorkspace: vi.fn(() => folder)
      })
      registerWithFakes(mainWindow, runtime, store)
      await expect(
        handlers.get('pty:spawn')!(null, {
          ...restartSpawnArgs({ replacesPtyId: 'pty-old' }),
          worktreeId: folderId,
          cwd: process.cwd()
        })
      ).resolves.toMatchObject({ id: 'pty-new' })
      expect(store.getWorkspaceSession().tabsByWorktree[folderId]).toHaveLength(1)
      expect(leafBinding()).toBe('pty-new')
      expect(store.getWorkspaceSession().terminalLayoutsByTabId[tabId].root).toEqual({
        type: 'leaf',
        leafId
      })
    }
  )
})
