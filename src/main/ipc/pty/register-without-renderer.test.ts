import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import {
  getLocalPtyProvider,
  getPtyRendererDeliveryDebugSnapshot,
  registerPtyHandlers,
  registerSshPtyProvider,
  setPtyOwnership,
  unregisterSshPtyProvider
} from '../pty'
import { registerHeadlessPtyRuntime } from './register-headless-runtime'
import { onMock } from '../pty-ipc-mock-registry'

vi.mock('electron', () => import('../pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('../pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
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

describe('PTY registration without renderer delivery', () => {
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    installObservableDaemonTestProvider,
    getPtyWriteListener
  } = setupPtyIpcSuite()

  it('keeps daemon output and exits flowing to the runtime without renderer work', async () => {
    vi.useFakeTimers()
    const daemon = installObservableDaemonTestProvider()
    const runtime = new OrcaRuntimeService()
    const setController = vi.spyOn(runtime, 'setPtyController')
    const onData = vi.spyOn(runtime, 'onPtyData').mockReturnValue(6)
    const onExit = vi.spyOn(runtime, 'onPtyExit').mockImplementation(() => {})
    const onLifecycleExit = vi.fn()
    setPtyOwnership('daemon-pty', null)
    const initialTimerCount = vi.getTimerCount()

    await registerHeadlessPtyRuntime(
      runtime,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { onPtyExit: onLifecycleExit }
    )
    const controller = setController.mock.calls[0]?.[0]
    expect(controller).toBeDefined()
    expect(vi.getTimerCount()).toBe(initialTimerCount)
    daemon.emitData('daemon-pty', 'output')
    daemon.emitDataGap('daemon-pty', 3)
    daemon.emitExit('daemon-pty', 0)

    expect(onData).toHaveBeenCalledWith('daemon-pty', 'output', expect.any(Number), 6, undefined)
    expect(onExit).toHaveBeenCalledWith('daemon-pty', 0, undefined, { providerExitObserved: true })
    expect(onLifecycleExit).toHaveBeenCalledWith('daemon-pty', expect.any(Number))
    await expect(controller?.serializeBuffer?.('daemon-pty')).resolves.toBeNull()
    expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
      pendingChars: 0,
      rendererInFlightChars: 0,
      flushScheduled: false,
      diagnostics: { windowFocused: null, windowVisible: null, windowMinimized: null }
    })
    expect(mainWindow.webContents.on).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
    expect(daemon.pauseProducer).not.toHaveBeenCalled()
  })

  it('routes local and SSH control to their providers, including attach and buffer snapshots', async () => {
    const remote = installObservableDaemonTestProvider()
    const remoteProvider = getLocalPtyProvider()
    registerSshPtyProvider('ssh-a', remoteProvider)
    const local = installObservableDaemonTestProvider()
    const localProvider = getLocalPtyProvider()
    const localClear = vi.spyOn(localProvider, 'clearBuffer')
    const remoteClear = vi.spyOn(remoteProvider, 'clearBuffer')
    const attach = vi.spyOn(localProvider, 'attach').mockResolvedValue({})
    const runtime = new OrcaRuntimeService()
    const setController = vi.spyOn(runtime, 'setPtyController')
    const remoteId = 'ssh:ssh-a@@remote-pty'
    local.getBufferSnapshot.mockResolvedValue({ data: 'local history', cols: 80, rows: 24 })
    remote.getBufferSnapshot.mockResolvedValue({ data: 'remote history', cols: 100, rows: 30 })
    await registerHeadlessPtyRuntime(runtime)
    const controller = setController.mock.calls[0]?.[0]
    if (!controller) {
      throw new Error('missing runtime PTY controller')
    }

    expect(controller.write('daemon-pty', 'local input')).toBe(true)
    expect(controller.write(remoteId, 'remote input')).toBe(true)
    await controller.clearBuffer?.('daemon-pty')
    await controller.clearBuffer?.(remoteId)
    await expect(controller.attach?.('daemon-pty')).resolves.toBe(true)
    await expect(controller.attach?.(remoteId)).resolves.toBe(false)
    await expect(controller.serializeProviderBuffer?.('daemon-pty')).resolves.toMatchObject({
      data: 'local history'
    })
    await expect(controller.serializeProviderBuffer?.(remoteId)).resolves.toMatchObject({
      data: 'remote history'
    })
    expect(local.write).toHaveBeenCalledExactlyOnceWith('daemon-pty', 'local input')
    expect(remote.write).toHaveBeenCalledExactlyOnceWith(remoteId, 'remote input')
    expect(localClear).toHaveBeenCalledExactlyOnceWith('daemon-pty')
    expect(remoteClear).toHaveBeenCalledExactlyOnceWith(remoteId)
    expect(attach).toHaveBeenCalledExactlyOnceWith('daemon-pty')

    unregisterSshPtyProvider('ssh-a')
    expect(controller.write(remoteId, 'disconnected input')).toBe(false)
    await expect(controller.probePtyLiveness?.(remoteId)).resolves.toBeNull()
    expect(local.write).toHaveBeenCalledTimes(1)
  })

  it('rejects renderer input when no renderer owns the registration', async () => {
    const daemon = installObservableDaemonTestProvider()
    const runtime = new OrcaRuntimeService()
    setPtyOwnership('daemon-pty', null)
    await registerHeadlessPtyRuntime(runtime)

    getPtyWriteListener()(mainWindowIpcEvent, { id: 'daemon-pty', data: 'untrusted' })
    expect(
      handlers.get('pty:writeAccepted')?.(mainWindowIpcEvent, {
        id: 'daemon-pty',
        data: 'untrusted'
      })
    ).toBe(false)
    expect(daemon.write).not.toHaveBeenCalled()
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()
  })

  it('detaches desktop lifecycle listeners and restores delivery after headless re-registration', async () => {
    vi.useFakeTimers()
    const daemon = installObservableDaemonTestProvider()
    const provider = getLocalPtyProvider()
    const subscribe = vi.mocked(provider.onData).getMockImplementation()
    if (!subscribe) {
      throw new Error('missing daemon data subscription')
    }
    const unsubscribe = vi.fn()
    const onDataSubscribe = vi.spyOn(provider, 'onData').mockImplementation((listener) => {
      const dispose = subscribe(listener)
      return () => {
        unsubscribe()
        dispose()
      }
    })
    const runtime = new OrcaRuntimeService()
    const onData = vi.spyOn(runtime, 'onPtyData').mockReturnValue(6)
    const rendererEvents = new EventEmitter()
    mainWindow.webContents.on.mockImplementation((event, listener) =>
      rendererEvents.on(event, listener)
    )
    mainWindow.webContents.removeListener.mockImplementation((event, listener) =>
      rendererEvents.removeListener(event, listener)
    )
    const renderer = {
      ...mainWindow,
      webContents: Object.assign(mainWindow.webContents, { id: 1 })
    }
    registerPtyHandlers(renderer, runtime)
    expect(rendererEvents.listenerCount('did-finish-load')).toBe(1)
    expect(rendererEvents.listenerCount('render-process-gone')).toBe(2)

    await registerHeadlessPtyRuntime(runtime)
    expect(rendererEvents.eventNames()).toEqual([])
    expect(onDataSubscribe).toHaveBeenCalledTimes(2)
    expect(unsubscribe).toHaveBeenCalledOnce()
    mainWindow.webContents.send.mockClear()
    daemon.emitData('daemon-pty', 'output')
    vi.advanceTimersByTime(20)
    expect(onData).toHaveBeenCalledTimes(1)
    expect(mainWindow.webContents.send).not.toHaveBeenCalled()

    registerPtyHandlers(renderer, runtime)
    expect(unsubscribe).toHaveBeenCalledTimes(2)
    const ready = onMock.mock.calls.findLast(
      ([channel]) => channel === 'pty:rendererDispatcherReady'
    )?.[1]
    ready(mainWindowIpcEvent)
    daemon.emitData('daemon-pty', 'output')
    vi.advanceTimersByTime(20)
    expect(onData).toHaveBeenCalledTimes(2)
    expect(rendererEvents.listenerCount('did-finish-load')).toBe(1)
    expect(rendererEvents.listenerCount('render-process-gone')).toBe(2)
    expect(mainWindow.webContents.send).toHaveBeenCalledWith(
      'pty:data',
      expect.objectContaining({ id: 'daemon-pty', data: 'output' })
    )
  })
})
