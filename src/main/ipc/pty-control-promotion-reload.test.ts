import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  handoffPtyRendererOwnership,
  registerPtyHandlers,
  registerPtyRenderer,
  setLocalPtyProvider
} from './pty'
import { ptyRendererOwners } from './pty-renderer-owners'
import { LocalPtyProvider } from '../providers/local-pty-provider'

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

describe('control promotion PTY reload', () => {
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    foreignWindowIpcEvent,
    createMockProc,
    getPtyWriteListener
  } = setupPtyIpcSuite()
  type WebContentsMock = typeof mainWindow.webContents

  const activeListeners = (webContents: WebContentsMock, eventName: string): (() => void)[] => {
    const removed = new Set(
      webContents.removeListener.mock.calls
        .filter(([event]) => event === eventName)
        .map(([, listener]) => listener)
    )
    return webContents.on.mock.calls
      .filter(([event, listener]) => event === eventName && !removed.has(listener))
      .map(([, listener]) => listener as () => void)
  }
  const finishLoad = (webContents: WebContentsMock): void => {
    activeListeners(webContents, 'did-finish-load').forEach((listener) => listener())
  }
  const reload = (webContents: WebContentsMock): void => {
    for (const listener of activeListeners(webContents, 'did-start-navigation')) {
      ;(
        listener as unknown as (details: {
          isMainFrame: boolean
          isSameDocument: boolean
        }) => void
      )({ isMainFrame: true, isSameDocument: false })
    }
    finishLoad(webContents)
  }

  it('preserves a promoted local PTY for one reload then sweeps a manual reload', async () => {
    const mockProc = createMockProc()
    const kill = mockProc.proc.kill
    spawnMock.mockReturnValue(mockProc.proc)
    let promotionReloadId: number | null = null
    const consumedPromotionReloads: number[] = []
    const isRecoveryReloadInFlight = (webContentsId: number): boolean => {
      if (promotionReloadId !== webContentsId) {
        return false
      }
      promotionReloadId = null
      consumedPromotionReloads.push(webContentsId)
      return true
    }

    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight, reuseRegisteredState: true }
    )
    finishLoad(mainWindow.webContents)
    const result = (await handlers.get('pty:spawn')!(mainWindowIpcEvent, {
      cols: 80,
      rows: 24
    })) as { id: string }
    const secondary = foreignWindowIpcEvent.sender
    registerPtyRenderer(secondary as never)
    finishLoad(secondary)
    ptyRendererOwners.markDispatcherReady(secondary as never)
    handoffPtyRendererOwnership([result.id], mainWindow.webContents as never, secondary as never)
    registerPtyHandlers(
      { ...mainWindow, webContents: secondary } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight, reuseRegisteredState: true }
    )

    promotionReloadId = secondary.id
    reload(secondary)

    expect(kill).not.toHaveBeenCalled()
    expect(ptyRendererOwners.getOwner(result.id)?.webContentsId).toBe(secondary.id)
    ptyRendererOwners.markDispatcherReady(secondary as never)
    getPtyWriteListener()(foreignWindowIpcEvent, { id: result.id, data: 'still-live' })
    expect(mockProc.proc.write).toHaveBeenCalledWith('still-live')
    expect(consumedPromotionReloads).toEqual([secondary.id])

    reload(secondary)
    expect(kill).toHaveBeenCalledOnce()
  })

  it('consumes promotion suppression under a persistent provider before local fallback', async () => {
    let pendingPromotionReload = true
    const isRecoveryReloadInFlight = vi.fn(() => {
      const pending = pendingPromotionReload
      pendingPromotionReload = false
      return pending
    })
    registerPtyHandlers(
      mainWindow as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { isRecoveryReloadInFlight }
    )
    setLocalPtyProvider({
      spawn: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      onData: vi.fn(() => vi.fn()),
      onExit: vi.fn(() => vi.fn()),
      listProcesses: vi.fn(async () => []),
      getForegroundProcess: vi.fn(async () => null)
    } as never)

    finishLoad(mainWindow.webContents)

    expect(isRecoveryReloadInFlight).toHaveBeenCalledOnce()
    const mockProc = createMockProc()
    const kill = mockProc.proc.kill
    spawnMock.mockReturnValue(mockProc.proc)
    const localProvider = new LocalPtyProvider()
    await localProvider.spawn({ cols: 80, rows: 24 })
    localProvider.advanceGeneration()
    setLocalPtyProvider(localProvider)

    finishLoad(mainWindow.webContents)

    expect(kill).toHaveBeenCalledOnce()
    expect(isRecoveryReloadInFlight).toHaveBeenCalledTimes(2)
  })
})
