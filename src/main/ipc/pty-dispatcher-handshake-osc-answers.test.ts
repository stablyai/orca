import { describe, expect, it, vi } from 'vitest'
import { onMock, spawnMock } from './pty-ipc-mock-registry'
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
    getPtySetRendererPtyVisibleListener,
    getPtyRendererDispatcherReadyListener,
    getMainFrameNavigationListener,
    getPtyResizeListener
  } = setupPtyIpcSuite()

  it('ignores a dispatcher-ready handshake from a sender other than the main window', async () => {
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
      const readyCall = onMock.mock.calls.find(
        (call: unknown[]) => call[0] === 'pty:rendererDispatcherReady'
      )!
      const rawReadyListener = readyCall[1] as (event: unknown) => void
      vi.advanceTimersByTime(1)

      // Why: a straggler handshake from a dying window must not reopen the gate (or trigger the destructive reconcile) for the new page.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()
      rawReadyListener({ sender: { isDestroyed: () => false } })
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: false
      })

      // The genuine main-window handshake still opens the gate and drains.
      rawReadyListener({ sender: mainWindow.webContents })
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'post-reload output'
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('cancels the dispatcher-ready watchdog when the handshake arrives in time', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, cwd: '/tmp' })
      const handleRendererLoading = getMainFrameNavigationListener()
      const handleRendererDispatcherReady = getPtyRendererDispatcherReadyListener()
      vi.advanceTimersByTime(1)

      // A timely handshake must cancel the reload watchdog so no orphaned ~10s timer lingers (forced-count guard can't catch it — the watchdog no-ops once ready).
      handleRendererLoading()
      handleRendererDispatcherReady()
      vi.advanceTimersByTime(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 0
      })

      // Advancing well past the watchdog window leaves the forced counter at zero.
      vi.advanceTimersByTime(20_000)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it("cancels a prior registration's armed dispatcher-ready watchdog when handlers re-register (no orphaned timer across window re-creation)", async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, cwd: '/tmp' })
      const handleRendererLoading = getMainFrameNavigationListener()
      // Drain the initial dispatcher-ready flush; the baseline is timer-free.
      vi.advanceTimersByTime(1)
      expect(vi.getTimerCount()).toBe(0)

      // A reload closes the gate and arms the ~10s self-heal watchdog on THIS registration's closure.
      handleRendererLoading()
      expect(vi.getTimerCount()).toBe(1)

      // Re-registering must cancel the prior closure's watchdog (cross-registration bridge) or it later force-opens a dead window's gate.
      registerPtyHandlers(mainWindow as never)
      expect(vi.getTimerCount()).toBe(0)

      // And no orphaned ~10s watchdog fires later (removing the bridge cancel turns this red).
      vi.advanceTimersByTime(20_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('preserves background-origin metadata for repaint output caused by a hidden resize', async () => {
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
      const resizePty = getPtyResizeListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: false })
      resizePty(null, { id: spawnResult.id, cols: 72, rows: 24 })
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      mockProc.emitData('\x1b[2Khidden-resize redraw')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: '\x1b[2Khidden-resize redraw',
        background: true
      })

      mainWindow.webContents.send.mockClear()
      resizePty(null, { id: spawnResult.id, cols: 80, rows: 24 })
      mockProc.emitData('visible repaint')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'visible repaint'
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not keep hidden resize metadata after visible user input', async () => {
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
      const resizePty = getPtyResizeListener()
      const writePty = getPtyWriteListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: false })
      resizePty(null, { id: spawnResult.id, cols: 72, rows: 24 })
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      writePty(mainWindowIpcEvent, { id: spawnResult.id, data: 'x' })
      mockProc.emitData('x')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'x'
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('answers agent startup OSC color queries before renderer batching', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        launchAgent: 'codex',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }
      mockProc.proc.write.mockClear()
      mainWindow.webContents.send.mockClear()

      const sourceData = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\ready'
      mockProc.emitData(sourceData)

      // Answered in the query's own turn. A cooked tty echoes the reply as well as
      // delivering it, and the echo is contained by the output-side projections (#12112);
      // withholding the write is what let replies overtake each other (#15559).
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      vi.advanceTimersByTime(2)
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'ready',
        rawLength: sourceData.length,
        transformed: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('answers combined agent startup OSC foreground and background color queries', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        launchAgent: 'codex',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }
      mockProc.proc.write.mockClear()
      mainWindow.webContents.send.mockClear()

      const sourceData = '\x1b]10;?;?\x1b\\ready'
      mockProc.emitData(sourceData)

      // Both slots of a duplicate-slot query are answered in that same turn.
      expect(mockProc.proc.write).toHaveBeenCalledTimes(2)
      vi.advanceTimersByTime(2)
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]10;rgb:eeee/eeee/eeee\x1b\\')
      expect(mockProc.proc.write).toHaveBeenCalledWith('\x1b]11;rgb:1111/1111/1111\x1b\\')
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'ready',
        rawLength: sourceData.length,
        transformed: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not answer ordinary terminal OSC color queries in main', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }
      mainWindow.webContents.send.mockClear()

      const query = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
      mockProc.emitData(`${query}ready`)

      expect(mockProc.proc.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: `${query}ready`
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not answer agent OSC color commands that only start like startup queries', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const spawnResult = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        launchAgent: 'codex',
        terminalColorQueryReplies: {
          foreground: '#eeeeee',
          background: '#111111'
        }
      })) as { id: string }
      mockProc.proc.write.mockClear()
      mainWindow.webContents.send.mockClear()

      const command = '\x1b]10;?not-a-query\x1b\\'
      mockProc.emitData(`${command}ready`)

      expect(mockProc.proc.write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: `${command}ready`
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
