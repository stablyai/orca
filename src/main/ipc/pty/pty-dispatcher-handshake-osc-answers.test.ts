import { describe, expect, it, vi } from 'vitest'
import { onMock, spawnMock } from '../pty-ipc-mock-registry'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import { registerPtyHandlers } from './register-handlers'
import { getPtyRendererDeliveryDebugSnapshot } from './delivery/debug'
import { _resetColorQueryReplyColorsForTest } from './provider/registry'
import { _resetPtyOwnerHostColorsForTest } from '../../../shared/pty-owner-color-query-colors'
import { _resetTerminalViewAttributesForTest } from '../../runtime/terminal-view-attribute-store'

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

describe('registerPtyHandlers', () => {
  const {
    handlers,
    mainWindow,
    mainWindowIpcEvent,
    createMockProc,
    getPtyWriteListener,
    getPtySetRendererPtyVisibleListener,
    getPtySetHiddenRendererPtyListener,
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

      // A dying page's handshake must not reopen or reconcile the replacement page's gate.
      handleRendererLoading()
      mainWindow.webContents.send.mockClear()
      rawReadyListener({ sender: { isDestroyed: () => false } })
      mockProc.emitData('post-reload output')
      vi.advanceTimersByTime(8)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: false
      })

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

      // Assert timer cleanup too: an orphaned watchdog can no-op without incrementing forced-ready.
      handleRendererLoading()
      handleRendererDispatcherReady()
      vi.advanceTimersByTime(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererPtyDispatcherReady: true,
        rendererDispatcherReadyForcedCount: 0
      })

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

      handleRendererLoading()
      expect(vi.getTimerCount()).toBe(1)

      // Re-registration must cancel the outgoing closure's watchdog before it can reopen the old gate.
      registerPtyHandlers(mainWindow as never)
      expect(vi.getTimerCount()).toBe(0)

      vi.advanceTimersByTime(20_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not tag output read after reveal as background when the hidden resize repaint was gated', async () => {
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
      const setHidden = getPtySetHiddenRendererPtyListener()
      const resizePty = getPtyResizeListener()
      mainWindow.webContents.send.mockClear()

      setRendererPtyVisible(null, { id: spawnResult.id, visible: false })
      setHidden(null, { id: spawnResult.id, hidden: true })
      resizePty(null, { id: spawnResult.id, cols: 72, rows: 24 })
      mockProc.emitData('\x1b[2Khidden-resize repaint')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'pty:data',
        expect.objectContaining({ data: '\x1b[2Khidden-resize repaint' })
      )

      setHidden(null, { id: spawnResult.id, hidden: false })
      setRendererPtyVisible(null, { id: spawnResult.id, visible: true })
      mainWindow.webContents.send.mockClear()
      // The app's post-reveal full repaint: a background tag makes the renderer drop it.
      mockProc.emitData('\x1b[2Kfull repaint')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: '\x1b[2Kfull repaint'
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

      // Reply in the query's turn to preserve order; output projections contain cooked-tty echo (#12112, #15559).
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
  it('answers a plain shell at the owner, then from the colours the renderer pushes', async () => {
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

      const query = '\x1b]11;?\x1b\\'
      mockProc.emitData(`${query}ready`)
      const pushViewAttributes: unknown = onMock.mock.calls.find(
        (call: unknown[]) => call[0] === 'pty:terminalViewAttributes'
      )?.[1]
      if (typeof pushViewAttributes !== 'function') {
        throw new Error('pty:terminalViewAttributes listener was not registered')
      }
      pushViewAttributes(null, {
        foreground: [0, 0, 0],
        background: [0x12, 0x34, 0x56],
        cursor: [0, 0, 0],
        ansi: Array.from({ length: 256 }, () => [0, 0, 0]),
        colorSchemeMode: 'light',
        cursorStyle: 'block',
        cursorBlink: false
      })
      mockProc.emitData(query)

      expect(mockProc.proc.write.mock.calls).toEqual([
        ['\x1b]11;rgb:1111/1111/1111\x1b\\'],
        ['\x1b]11;rgb:1212/3434/5656\x1b\\']
      ])
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'ready',
        rawLength: `${query}ready${query}`.length,
        transformed: true
      })
    } finally {
      _resetTerminalViewAttributesForTest()
      _resetColorQueryReplyColorsForTest()
      _resetPtyOwnerHostColorsForTest()
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
