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
    createMockProc,
    installObservableDaemonTestProvider,
    getPtyAckDataListener,
    getPtyRendererDispatcherReadyListener,
    getMainFrameNavigationListener,
    countResyncUnansweredWarnings,
    getPtyDataSendCalls,
    reportRendererDeliveryState,
    spawnAndSaturateRendererDeliveryGate
  } = setupPtyIpcSuite()

  it('clears resync probe state when the window is destroyed', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    let destroyed = false
    const destroyableWindow = {
      isDestroyed: () => destroyed,
      isFocused: () => true,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }
    }

    try {
      registerPtyHandlers(destroyableWindow as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, cwd: '/tmp' })
      destroyableWindow.webContents.send.mockClear()
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(8)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }
      mockProc.emitData('stuck-output')
      // Only the probe's hygiene timeout remains; the dispatcher-ready handshake already drained the pending flush.
      expect(vi.getTimerCount()).toBe(1)

      destroyed = true
      mockProc.emitData('post-destroy output')

      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(countResyncUnansweredWarnings(warnSpy)).toBe(0)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('reports delivery health over invoke without mutating any delivery state', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      await spawnAndSaturateRendererDeliveryGate(mockProc)

      // The field wedge in miniature: renderer received nothing, no ACK ever.
      const health = reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {}
      })

      expect(health).toMatchObject({
        inFlightTotalChars: 512 * 1024,
        inFlightPtyCount: 1,
        msSinceLastAck: null
      })
      expect(health.writtenOff).toBeUndefined()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('merges cumulative processed totals from a health report as a repair lane', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)

      // Lost-ACK variant: renderer processed everything, only ACKs vanished; a plain report (no heal) must drain the debt.
      const health = reportRendererDeliveryState({
        receivedCharsByPty: { [spawnResult.id]: 512 * 1024 },
        processedCharsByPty: { [spawnResult.id]: 512 * 1024 }
      })

      expect(health).toMatchObject({ inFlightTotalChars: 0, inFlightPtyCount: 0 })
      expect(health.writtenOff).toBeUndefined()
      // Fully reopened gate drains one 16K slice per batcher tick (0/1/2 ms).
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toHaveLength(35)
    } finally {
      vi.useRealTimers()
    }
  })
  it('heals a dead push channel: writes off unreceived bytes and returns restore markers', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)

      const healed = reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {},
        heal: true,
        rendererPtyDataListenerCount: 1
      })

      // 512 KiB never-received is written off; the 88 KiB pending is dropped too (snapshot restore covers everything at/before the marker).
      expect(healed.writtenOff).toEqual([{ id: spawnResult.id, writtenOffChars: 512 * 1024 }])
      expect(healed).toMatchObject({ inFlightTotalChars: 0, inFlightPtyCount: 0 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        pendingChars: 0,
        pendingDroppedChars: 88 * 1024
      })
      expect(warnSpy).toHaveBeenCalledWith(
        '[pty] delivery heal: wrote off renderer-bound bytes lost in push channel',
        expect.objectContaining({ rendererPtyDataListenerCount: 1 })
      )

      // Delivery is unwedged: fresh output flows to the renderer again.
      mockProc.emitData('after-heal')
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toHaveLength(33)
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('reactivates globally blocked work immediately after a delivery writeoff', () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never)
      const bulkIds = Array.from({ length: 16 }, (_, index) => `writeoff-bulk-${index}`)
      mainWindow.webContents.send.mockClear()
      for (const id of bulkIds) {
        provider.emitData(id, 'x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 8 * 1024 * 1024,
        flushScheduled: false
      })

      provider.emitData('writeoff-held', 'held')
      vi.advanceTimersByTime(2)
      expect(
        getPtyDataSendCalls().some(
          (call) => (call[1] as { id?: string } | undefined)?.id === 'writeoff-held'
        )
      ).toBe(false)
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(false)

      reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {},
        heal: true,
        rendererPtyDataListenerCount: 1
      })
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(true)
      vi.advanceTimersByTime(0)

      expect(getPtyDataSendCalls().at(-1)).toEqual([
        'pty:data',
        { id: 'writeoff-held', data: 'held' }
      ])
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
  it('never writes off bytes the renderer received but has not parsed yet', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)

      // Parse backpressure, not a wedge: ACK credit is deferred to the scheduler consume point and still repays.
      const health = reportRendererDeliveryState({
        receivedCharsByPty: { [spawnResult.id]: 512 * 1024 },
        processedCharsByPty: {},
        heal: true,
        rendererPtyDataListenerCount: 1
      })

      expect(health.writtenOff).toBeUndefined()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('refuses a heal while main has seen a recent ACK', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      const ackData = getPtyAckDataListener()
      ackData(null, { id: spawnResult.id, processedChars: 16 * 1024 })

      // A pty still round-trips ACKs, so the channel isn't dead — a heal must not destroy accounting.
      const blocked = reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {},
        heal: true
      })
      expect(blocked.writtenOff).toBeUndefined()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 496 * 1024
      })

      // Once main-side ACK silence crosses the floor, the same heal proceeds.
      vi.advanceTimersByTime(10_000)
      const healed = reportRendererDeliveryState({
        receivedCharsByPty: {},
        processedCharsByPty: {},
        heal: true
      })
      expect(healed.writtenOff).toEqual([{ id: spawnResult.id, writtenOffChars: 512 * 1024 }])
    } finally {
      vi.useRealTimers()
    }
  })
  it('zeroes renderer in-flight delivery counters when the renderer lifecycle resets', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      await spawnAndSaturateRendererDeliveryGate(mockProc)
      const handleRendererLoading = getMainFrameNavigationListener()
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightPtyCount: 1,
        rendererInFlightChars: 512 * 1024
      })

      handleRendererLoading()

      // Why: reload kills the dispatcher that would ACK, so stale counters would gate PTYs in the fresh renderer forever.
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0
      })
      // Main holds sends until the replacement page confirms its dispatcher; the reset arms a bounded handshake watchdog.
      expect(vi.getTimerCount()).toBe(1)

      mockProc.emitData('after-reload')
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)

      getPtyRendererDispatcherReadyListener()()
      // One 2ms batch window releases the fresh page's held output.
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(33)
    } finally {
      vi.useRealTimers()
    }
  })
})
