import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from '../pty-ipc-mock-registry'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import { registerPtyHandlers } from '../register-handlers'
import { getPtyRendererDeliveryDebugSnapshot } from './debug'

vi.mock('electron', () => import('../pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('../pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('../pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../../opencode/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../../mimo/hook-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../../agent-hooks/server', () =>
  import('../pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../../pi/titlebar-extension-service', () =>
  import('../pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../../pwsh', () => import('../pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../../../wsl', async (importOriginal) =>
  (await import('../pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../../telemetry/client', () =>
  import('../pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../../telemetry/classify-error', () =>
  import('../pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../../cli/linux-terminal-orca-cli-shim', () =>
  import('../pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../../memory/pty-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../../agent-hooks/migration-unsupported-pty-state', () =>
  import('../pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../../codex/codex-pane-account-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../../codex/codex-state-db-backfill-recovery', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const {
    handlers,
    mainWindow,
    createMockProc,
    installObservableDaemonTestProvider,
    getPtyAckDataListener
  } = setupPtyIpcSuite()

  it('caps per-PTY pending output while the renderer is starved and heals via a droppedOutput sentinel', async () => {
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
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      // Model a frozen renderer: saturate its in-flight window without ACKs.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }

      mockProc.emitData('y'.repeat(3 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })

      mockProc.emitData('z'.repeat(64 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })

      // Restore from the main snapshot after the pending cap drops bytes.
      mainWindow.webContents.send.mockClear()
      ackData(null, { id: spawn.id, charCount: 512 * 1024 })
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawn.id,
        data: '',
        droppedOutput: true
      })

      mainWindow.webContents.send.mockClear()
      mockProc.emitData('back to normal')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawn.id,
        data: 'back to normal'
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('carves reply-eliciting queries out of a pending-cap bulk drop so probes survive', async () => {
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
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      // Saturate the in-flight window so everything after buffers in pendingData.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }

      // Flood past the cap with a DSR probe and a mode-2031 withdrawal split at the chunk edge.
      mockProc.emitData(
        `${'y'.repeat(2 * 1024 * 1024)}\x1b[6n${'y'.repeat(1024 * 1024)}\x1b[?2031h prompt \x1b[?20`
      )
      // While latched, later queries and the withdrawal continuation must still be carved out.
      mockProc.emitData(`31l${'z'.repeat(32 * 1024)}\x1b[0c${'z'.repeat(32 * 1024)}`)

      mainWindow.webContents.send.mockClear()
      ackData(null, { id: spawn.id, charCount: 512 * 1024 })
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawn.id,
        data: '\x1b[6n\x1b[0c\x1b[?2031l',
        droppedOutput: true
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('scales the pending-output cap with the scrollback setting', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      // 50k-row scrollback ⇒ 6 MB pending cap instead of the 2 MB floor.
      registerPtyHandlers(mainWindow as never, undefined, undefined, (() => ({
        terminalScrollbackRows: 50_000
      })) as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, cwd: '/tmp' })
      mainWindow.webContents.send.mockClear()

      // Retain output above the floor but below the scrollback-scaled cap.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }
      mockProc.emitData('y'.repeat(3 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot().pendingChars).toBeGreaterThan(3 * 1024 * 1024)

      mockProc.emitData('z'.repeat(4 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('pauses the producer at the pending high watermark and resumes after drain', async () => {
    vi.useFakeTimers()
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()

      // Model node-pty pause stopping reads by withholding further chunks while paused.
      const chunk = 'x'.repeat(64 * 1024)
      let chunks = 0
      while (provider.pauseProducer.mock.calls.length === 0 && chunks < 100) {
        provider.emitData('flood-pty', chunk)
        chunks++
      }

      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(provider.pauseProducer).toHaveBeenCalledWith('flood-pty')
      expect(chunks).toBe(5)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 320 * 1024,
        peakPendingChars: 320 * 1024
      })

      vi.runAllTimers()
      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(provider.resumeProducer).toHaveBeenCalledWith('flood-pty')
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({ pendingChars: 0 })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PTY producer flow control', () => {
  const { mainWindow, installObservableDaemonTestProvider, getPtyDataSendCalls } =
    setupPtyIpcSuite()

  it('resumes a paused producer when the PTY exits before draining', async () => {
    vi.useFakeTimers()
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()

      const finalPendingData = 'x'.repeat(320 * 1024)
      provider.emitData('flood-pty', finalPendingData)
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)

      // Exit must release pause even when pending output never drained.
      provider.emitExit('flood-pty', 0)
      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(provider.resumeProducer).toHaveBeenCalledWith('flood-pty')
    } finally {
      vi.useRealTimers()
    }
  })
  it('releases a paused producer when handlers re-register for a replacement window', () => {
    vi.useFakeTimers()
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()

      provider.emitData('flood-pty', 'x'.repeat(320 * 1024))
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)

      // Re-registration must reset the outgoing session before neutralizing its bridge, or the shell remains paused.
      registerPtyHandlers(mainWindow as never)
      expect(provider.resumeProducer).toHaveBeenCalledWith('flood-pty')
    } finally {
      vi.useRealTimers()
    }
  })
  it('fences synchronous producer data and duplicate exit while releasing an exiting PTY', () => {
    vi.useFakeTimers()
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()

      const finalPendingData = 'x'.repeat(320 * 1024)
      provider.emitData('flood-pty', finalPendingData)
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      provider.resumeProducer.mockImplementation((id: string) => {
        provider.emitData(id, 'must-not-follow-exit')
        provider.emitExit(id, 0)
      })

      provider.emitExit('flood-pty', 0)

      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:data', { id: 'flood-pty', data: finalPendingData }],
        ['pty:exit', { id: 'flood-pty', code: 0, hostId: 'local' }]
      ])
      expect(
        getPtyDataSendCalls().some(
          (call) => (call[1] as { data?: string } | undefined)?.data === 'must-not-follow-exit'
        )
      ).toBe(false)
      expect(
        mainWindow.webContents.send.mock.calls.filter((call) => call[0] === 'pty:exit')
      ).toHaveLength(1)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not retry a complete payload after a synchronous renderer send failure', () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      mainWindow.webContents.send.mockClear()
      let failed = false
      let markerFailed = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel === 'pty:data' && payload.id === 'send-fail-complete' && !failed) {
            failed = true
            throw new Error('synthetic send failure')
          }
          if (channel === 'pty:modelRestoreNeeded' && !markerFailed) {
            markerFailed = true
            throw new Error('synthetic marker failure')
          }
        }
      )

      provider.emitData('send-fail-complete', 'lost-once')
      vi.advanceTimersByTime(2)

      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-complete', data: 'lost-once' }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        pendingChars: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)

      provider.emitData('send-fail-complete', 'recovery')
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toEqual([
        ['pty:data', { id: 'send-fail-complete', data: 'lost-once' }],
        ['pty:data', { id: 'send-fail-complete', data: 'recovery' }]
      ])
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
        id: 'send-fail-complete',
        reason: 'delivery-heal'
      })
      provider.emitData('send-fail-complete', 'after-marker-failure')
      vi.advanceTimersByTime(2)
      expect(
        mainWindow.webContents.send.mock.calls.filter(
          (call) => call[0] === 'pty:modelRestoreNeeded'
        )
      ).toHaveLength(2)
      expect(getPtyDataSendCalls().at(-1)).toEqual([
        'pty:data',
        { id: 'send-fail-complete', data: 'after-marker-failure' }
      ])
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
