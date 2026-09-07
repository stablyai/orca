import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, getPtyRendererDeliveryDebugSnapshot } from './pty'

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
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    createMockProc,
    installObservableDaemonTestProvider,
    getPtyWriteListener,
    getPtyRendererDispatcherReadyListener,
    getMainFrameNavigationListener,
    getPtyDataSendCalls
  } = setupPtyIpcSuite()

  it('keeps only a partial remainder after a synchronous renderer send failure', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()
      const firstChunk = 'x'.repeat(16 * 1024)
      let failed = false
      mainWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'pty:data' && !failed) {
          failed = true
          throw new Error('synthetic send failure')
        }
      })

      provider.emitData('send-fail-partial', `${firstChunk}tail`)
      vi.advanceTimersByTime(2)

      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-partial', data: firstChunk }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 4,
        rendererInFlightChars: 0,
        flushScheduled: true
      })
      expect(vi.getTimerCount()).toBe(1)

      vi.advanceTimersByTime(1)
      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-partial', data: firstChunk }],
        ['pty:data', { id: 'send-fail-partial', data: 'tail' }]
      ])
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
        id: 'send-fail-partial',
        reason: 'delivery-heal'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightChars: 4,
        flushScheduled: false
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('clears failed-delivery restore state when the renderer lifecycle resets', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      const resetRenderer = getMainFrameNavigationListener()
      const readyRenderer = getPtyRendererDispatcherReadyListener()
      let failed = false
      mainWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'pty:data' && !failed) {
          failed = true
          throw new Error('synthetic send failure')
        }
      })

      provider.emitData('send-fail-reset', 'lost-once')
      vi.advanceTimersByTime(2)
      resetRenderer()
      readyRenderer()
      mainWindow.webContents.send.mockClear()
      provider.emitData('send-fail-reset', 'repainted-page-data')
      vi.advanceTimersByTime(2)

      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-reset', data: 'repainted-page-data' }]
      ])
      expect(
        mainWindow.webContents.send.mock.calls.filter(
          (call) => call[0] === 'pty:modelRestoreNeeded'
        )
      ).toHaveLength(0)
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('commits interactive bypass removal and producer flow after a synchronous send failure', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    try {
      registerPtyHandlers(mainWindow as never)
      const spawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writePty = getPtyWriteListener()
      mainWindow.webContents.send.mockClear()
      let failed = false
      mainWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'pty:data' && !failed) {
          failed = true
          throw new Error('synthetic send failure')
        }
      })

      mockProc.emitData('older-')
      writePty(mainWindowIpcEvent, { id: spawn.id, data: 'x' })
      mockProc.emitData('redraw')

      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: spawn.id, data: 'older-redraw' }]])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        pendingChars: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)

      mockProc.emitData('recovery')
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
        id: spawn.id,
        reason: 'delivery-heal'
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('cleans up and emits exit once when the final data send fails synchronously', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      const pending = 'x'.repeat(320 * 1024)
      provider.emitData('send-fail-exit', pending)
      expect(provider.pauseProducer).toHaveBeenCalledWith('send-fail-exit')
      mainWindow.webContents.send.mockClear()
      mainWindow.webContents.send.mockImplementation((channel: string) => {
        if (channel === 'pty:data') {
          throw new Error('synthetic send failure')
        }
      })

      provider.emitExit('send-fail-exit', 7)

      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: 'send-fail-exit', data: pending }]])
      expect(
        mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')
      ).toEqual([['pty:exit', { id: 'send-fail-exit', code: 7 }]])
      expect(
        mainWindow.webContents.send.mock.calls.filter(
          (call) => call[0] === 'pty:modelRestoreNeeded'
        )
      ).toHaveLength(0)
      expect(provider.resumeProducer).toHaveBeenCalledWith('send-fail-exit')
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        pendingChars: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('delivers a pending-cap sentinel before exit and clears its pending timer', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      provider.emitData('flood-pty', 'x'.repeat(3 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0,
        flushScheduled: true
      })
      mainWindow.webContents.send.mockClear()

      provider.emitExit('flood-pty', 0)

      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:data', { id: 'flood-pty', data: '', droppedOutput: true }],
        ['pty:exit', { id: 'flood-pty', code: 0 }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
