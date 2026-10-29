import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  installRestartHarness,
  leafId,
  paneKey,
  registerWithFakes,
  restartSpawnArgs,
  tabId,
  worktreeId
} from './pty-pane-owner-swap.test-fixture'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

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
    await expect(handlers.get('pty:spawn')!(null, restartSpawnArgs())).resolves.toMatchObject({
      id: 'pty-old',
      isReattach: true
    })
    // Failed restarts must not leave a reason label that misclassifies later closure.
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
})
