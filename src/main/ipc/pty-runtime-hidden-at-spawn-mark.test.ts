import { describe, expect, it, vi } from 'vitest'
import { makeDeferred } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { isHiddenRendererPty } from './pty-hidden-delivery-gate'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { registerPtyHandlers } from './pty'

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

type RuntimeSpawnController = {
  spawn: (args: {
    cols: number
    rows: number
    sessionId?: string
    initiallyHidden?: boolean
  }) => Promise<{ id: string }>
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test doubles implement only the members these spawn paths read.
const testDouble = <T>(value: unknown): T => value as T

describe('runtime-controller spawn: hidden until a renderer view mounts', () => {
  const {
    mainWindow,
    installObservableDaemonTestProvider,
    getPtySetHiddenRendererPtyListener,
    getPtySetRendererPtyVisibleListener,
    getPtyDataSendCalls
  } = setupPtyIpcSuite()

  function simulateRendererReload(): void {
    const reloadHandlers = mainWindow.webContents.on.mock.calls
      .filter((call: unknown[]) => call[0] === 'did-finish-load')
      .map((call: unknown[]) => testDouble<() => void>(call[1]))
    expect(reloadHandlers.length).toBeGreaterThan(0)
    for (const handler of reloadHandlers) {
      handler()
    }
  }

  function createRuntimeMock() {
    return {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(() => 42),
      getPtyOutputSequence: vi.fn(() => 42),
      hasRemoteTerminalViewSubscriber: vi.fn(() => false),
      registerPreAllocatedHandleForPty: vi.fn()
    }
  }

  function installController(runtime: { setPtyController: ReturnType<typeof vi.fn> }) {
    registerPtyHandlers(testDouble(mainWindow), testDouble(runtime))
    return testDouble<RuntimeSpawnController>(runtime.setPtyController.mock.calls[0]?.[0])
  }

  it('marks a fresh daemon session hidden before spawn resolves', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    const spawnGate = makeDeferred()
    let mintedSessionId: string | undefined
    daemon.spawn.mockImplementation(async (options: { sessionId?: string }) => {
      mintedSessionId = options.sessionId
      await spawnGate.promise
      return { id: options.sessionId ?? 'daemon-pty' }
    })
    const controller = installController(runtime)

    const spawnPromise = controller.spawn({ cols: 80, rows: 24, initiallyHidden: true })
    await vi.waitFor(() => expect(mintedSessionId).toBeDefined())
    // Byte zero (Muse's startup queries) must already be main's to answer.
    expect(isHiddenRendererPty(mintedSessionId!)).toBe(true)

    spawnGate.resolve()
    const result = await spawnPromise
    expect(isHiddenRendererPty(result.id)).toBe(true)
  })

  it('paces a pane-less background PTY as backgrounded until a view reports visible', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    const controller = installController(runtime)

    const result = await controller.spawn({ cols: 80, rows: 24, initiallyHidden: true })
    expect(daemon.setPtyBackgrounded).toHaveBeenLastCalledWith(result.id, true)

    getPtySetRendererPtyVisibleListener()(null, { id: result.id, visible: true })
    expect(daemon.setPtyBackgrounded).toHaveBeenLastCalledWith(result.id, false)
  })

  it('keeps the runtime hidden mark and pacing across a renderer reload', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    const controller = installController(runtime)

    const result = await controller.spawn({ cols: 80, rows: 24, initiallyHidden: true })
    daemon.setPtyBackgrounded.mockClear()
    simulateRendererReload()

    // No renderer party exists to re-mark it, so main must keep answering its queries.
    expect(isHiddenRendererPty(result.id)).toBe(true)
    expect(daemon.setPtyBackgrounded).not.toHaveBeenCalledWith(result.id, false)
  })

  it('hands the mark to the renderer once a visible view unmarks it', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    const controller = installController(runtime)

    const result = await controller.spawn({ cols: 80, rows: 24, initiallyHidden: true })
    getPtySetRendererPtyVisibleListener()(null, { id: result.id, visible: true })
    getPtySetHiddenRendererPtyListener()(null, { id: result.id, hidden: false })
    expect(isHiddenRendererPty(result.id)).toBe(false)

    daemon.setPtyBackgrounded.mockClear()
    simulateRendererReload()

    // A reload must not resurrect a runtime mark on a PTY a renderer view already owned.
    expect(isHiddenRendererPty(result.id)).toBe(false)
    expect(daemon.setPtyBackgrounded).not.toHaveBeenCalledWith(result.id, true)
  })

  it('does not re-hide a PTY whose view mounted visible before spawn committed', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    const spawnGate = makeDeferred()
    let mintedSessionId: string | undefined
    daemon.spawn.mockImplementation(async (options: { sessionId?: string }) => {
      mintedSessionId = options.sessionId
      await spawnGate.promise
      return { id: options.sessionId ?? 'daemon-pty' }
    })
    const controller = installController(runtime)

    const spawnPromise = controller.spawn({ cols: 80, rows: 24, initiallyHidden: true })
    await vi.waitFor(() => expect(mintedSessionId).toBeDefined())
    // The visible mount reports visible and releases the pre-spawn mark.
    getPtySetRendererPtyVisibleListener()(null, { id: mintedSessionId!, visible: true })
    getPtySetHiddenRendererPtyListener()(null, { id: mintedSessionId!, hidden: false })
    spawnGate.resolve()
    const result = await spawnPromise

    expect(isHiddenRendererPty(result.id)).toBe(false)
    daemon.emitData(result.id, 'visible output')
    await vi.waitFor(() =>
      expect(getPtyDataSendCalls()).toContainEqual([
        'pty:data',
        expect.objectContaining({ id: result.id, data: 'visible output' })
      ])
    )
  })

  it('clears the pre-spawn mark when the runtime spawn fails', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    let mintedSessionId: string | undefined
    daemon.spawn.mockImplementation(async (options: { sessionId?: string }) => {
      mintedSessionId = options.sessionId
      throw new Error('spawn exploded')
    })
    const controller = installController(runtime)

    await expect(controller.spawn({ cols: 80, rows: 24, initiallyHidden: true })).rejects.toThrow(
      'spawn exploded'
    )
    expect(mintedSessionId).toBeDefined()
    expect(isHiddenRendererPty(mintedSessionId!)).toBe(false)
  })

  it('does not mark a reattach, whose session may already back a visible pane', async () => {
    const runtime = createRuntimeMock()
    const daemon = installObservableDaemonTestProvider()
    daemon.spawn.mockImplementation(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty',
      isReattach: true
    }))
    const controller = installController(runtime)

    const result = await controller.spawn({
      cols: 80,
      rows: 24,
      sessionId: 'existing-session',
      initiallyHidden: true
    })
    expect(isHiddenRendererPty(result.id)).toBe(false)
  })

  it('leaves spawns without the flag delivering to the renderer', async () => {
    const runtime = createRuntimeMock()
    installObservableDaemonTestProvider()
    const controller = installController(runtime)

    const result = await controller.spawn({ cols: 80, rows: 24 })
    expect(isHiddenRendererPty(result.id)).toBe(false)
  })

  it('answers a startup cursor-position query from the model with no renderer view', async () => {
    const daemon = installObservableDaemonTestProvider()
    const runtime = new OrcaRuntimeService(
      testDouble({
        getRepo: () => undefined,
        getRepos: () => [],
        addRepo: () => {},
        updateRepo: () => undefined,
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        setWorktreeMeta: () => undefined,
        removeWorktreeMeta: () => {},
        getGitHubCache: () => ({ pr: {}, issue: {} }),
        getSettings: () => ({
          workspaceDir: '/tmp/workspaces',
          nestWorkspaces: false,
          refreshLocalBaseRefOnWorktreeCreate: false,
          branchPrefix: 'none',
          branchPrefixCustom: '',
          terminalMainSideEffectAuthority: true,
          terminalHiddenDeliveryGate: true,
          terminalModelQueryAuthority: true
        })
      })
    )
    const setPtyController = vi.spyOn(runtime, 'setPtyController')
    registerPtyHandlers(testDouble(mainWindow), runtime)
    const controller = testDouble<RuntimeSpawnController>(setPtyController.mock.calls[0]?.[0])

    const result = await controller.spawn({ cols: 80, rows: 24, initiallyHidden: true })
    daemon.emitData(result.id, '\x1b[6n')
    await runtime.serializeMainTerminalBuffer(result.id)

    expect(daemon.write).toHaveBeenCalledWith(result.id, '\x1b[1;1R')
  })
})
