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
      // Reloaded page's dispatcher re-registers, releasing held sends (§1b).
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
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake to model a live page) so flood timing starts clean.
      vi.advanceTimersByTime(1)
      mainWindow.webContents.send.mockClear()

      // Saturate the PTY past the 512 KB per-PTY high-water with no ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }

      // Gate closed: sends stop at the cap and the remainder accrues as pending.
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

      // Renderer reload: the dead page never ACKs, so its in-flight/pending accounting must clear or the surviving PTY stays gated forever.
      handleRendererLoading()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0,
        pendingChars: 0,
        pendingPtyCount: 0,
        rendererLifecycleResetCount: 1,
        lastLifecycleResetClearedChars: 512 * 1024
      })

      // Boot window (§1b): dispatcher not re-registered, so sends must be held — bytes into the listener-less page drop yet count in-flight, re-pinning the gate.
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 'post-reload output'.length,
        pendingPtyCount: 1
      })

      // The dispatcher-ready handshake releases the held backlog; assert delivery actually resumes and pending drains, not just counters-zero.
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
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake).
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

      // Gate remains open: output after the iframe navigation reaches the fresh page without waiting for the watchdog.
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
      // Drain the initial dispatcher-ready flush (beforeEach fires the handshake).
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

      // Handshake while the gate is open proves a missed lifecycle reset; reconcile or survivors stay pinned at the cap.
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

      // Delivery has resumed: fresh output flows immediately instead of piling up behind the stale cap.
      mockProc.emitData('post-reconcile output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reconcile output'
      })

      // A straggler ACK from the dead page is clamped and cannot underflow the reconciled counters below zero.
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
      // Drain the initial ready-flush the beforeEach handshake schedules.
      vi.advanceTimersByTime(1)

      // Reload closes the gate; the reloaded page's dispatcher has not re-registered.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()

      // With shouldSendInteractiveOutputNow() true, only the `&& rendererPtyDispatcherReady` guard keeps the interactive echo out of the still-listener-less page.
      const redraw = '\x1b[20;2Hredraw'
      writeListener(mainWindowIpcEvent, { id: spawnResult.id, data: 'a' })
      mockProc.emitData(redraw)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: redraw.length,
        pendingPtyCount: 1
      })

      // The handshake releases the held echo (drained via the batch flush).
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

      // Reload closes the gate and arms the ~10s watchdog; the reloaded page never sends the handshake (dropped IPC), so output stays held.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: false,
        rendererDispatcherReadyForcedCount: 0
      })

      // Past the 10s watchdog window the gate self-heals (ready forced, backlog drains) instead of freezing permanently.
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
