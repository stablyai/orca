import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'
import { getPtyRendererDeliveryDebugSnapshot } from './pty/delivery/debug'

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
    getPtyWriteListener,
    getPtyAckDataListener,
    getPtySetRendererPtyVisibleListener,
    getPtyRendererDispatcherReadyListener,
    getMainWindowWebContentsListener,
    getMainFrameNavigationListener
  } = setupPtyIpcSuite()

  it('batches PTY output when it is not responding to recent input', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('background output')

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'background output'
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('preserves background-origin metadata when hidden output flushes after resume', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const setRendererPtyVisible = getPtySetRendererPtyVisibleListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      mockProc.emitData('visible output')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'visible output'
      })

      mainWindow.webContents.send.mockClear()
      setRendererPtyVisible(null, { id: spawnResult.id, visible: false })
      mockProc.emitData('\x1b[2Khidden-width redraw')
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: '\x1b[2Khidden-width redraw',
        background: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('marks visible renderer PTYs hidden while the renderer lifecycle resets', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const setRendererPtyVisible = getPtySetRendererPtyVisibleListener()
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      handleRendererLoading()
      handleRendererDispatcherReady()
      mockProc.emitData('reload-gap output')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'reload-gap output',
        background: true
      })

      mainWindow.webContents.send.mockClear()
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      mockProc.emitData('visible output')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'visible output'
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('resets leaked delivery accounting on renderer lifecycle reset so a saturated PTY resumes', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      // Drain the fixture's ready flush before measuring flood timing.
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      expect(vi.getTimerCount()).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024,
        pendingPtyCount: 1,
        rendererLifecycleResetCount: 0,
        lastLifecycleResetClearedChars: 0
      })

      // The dead page cannot ACK; clear its debt so surviving PTYs do not remain gated.
      handleRendererLoading()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        lastLifecycleResetClearedChars: 512 * 1024
      })

      // Hold bytes until the replacement dispatcher exists, or lost sends recreate permanent debt.
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 'post-reload output'.length,
        pendingPtyCount: 1
      })

      // Verify the handshake restores delivery, beyond merely clearing counters.
      handleRendererDispatcherReady()
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reload output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 'post-reload output'.length,
        pendingChars: 0,
        pendingPtyCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('ignores overlapping subframe navigation so an in-page iframe cannot reclose delivery', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const handleRendererNavigation = getMainWindowWebContentsListener('did-start-navigation')
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)

      // Main navigation closes the gate; the fresh dispatcher reopens it before an overlapping iframe navigates.
      handleRendererNavigation({ isMainFrame: true, isSameDocument: false })
      handleRendererDispatcherReady()
      handleRendererNavigation({ isMainFrame: false, isSameDocument: false })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        lastLifecycleResetClearedChars: 512 * 1024,
        rendererPtyDispatcherReady: true
      })

      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-subframe output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-subframe output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('reconciles stale delivery accounting when a fresh dispatcher-ready handshake arrives while the gate is still open (missed lifecycle reset)', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      const ackData = getPtyAckDataListener()
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024,
        rendererLifecycleResetCount: 0,
        rendererPtyDispatcherReady: true
      })

      // A handshake on an open gate exposes a missed lifecycle reset; reconcile stale debt.
      mainWindow.webContents.send.mockClear()
      handleRendererDispatcherReady()
      const reconciled = getPtyRendererDeliveryDebugSnapshot()
      expect(reconciled).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        rendererPtyDispatcherReady: true
      })
      expect(reconciled.lastLifecycleResetClearedChars).toBeGreaterThan(0)

      mockProc.emitData('post-reconcile output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reconcile output'
      })

      // Clamp straggler ACKs from the dead page to avoid underflow after reconciliation.
      ackData(null, { id: spawnResult.id, charCount: 512 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot().rendererInFlightChars).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('holds interactive input echo during the boot window until the dispatcher-ready handshake', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      const writeListener = getPtyWriteListener()
      vi.advanceTimersByTime(1)

      handleRendererLoading()
      mainWindow.webContents.send.mockClear()

      // Interactive bypass must still wait for the replacement page's dispatcher.
      const redraw = '\x1b[20;2Hredraw'
      writeListener(mainWindowIpcEvent, { id: spawnResult.id, data: 'a' })
      mockProc.emitData(redraw)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: redraw.length,
        pendingPtyCount: 1
      })

      handleRendererDispatcherReady()
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: redraw
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('force-opens the delivery gate if no dispatcher-ready handshake arrives after a reload', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const handleRendererLoading = getMainFrameNavigationListener()
      vi.advanceTimersByTime(1)

      // A missing reload handshake must recover through the bounded readiness watchdog.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: false,
        rendererDispatcherReadyForcedCount: 0
      })

      vi.advanceTimersByTime(10_000)
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reload output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 1
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PTY renderer send recovery', () => {
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
      ).toEqual([['pty:exit', { id: 'send-fail-exit', code: 7, hostId: 'local' }]])
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
        ['pty:exit', { id: 'flood-pty', code: 0, hostId: 'local' }]
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
