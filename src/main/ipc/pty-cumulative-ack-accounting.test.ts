import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  registerPtyHandlers,
  getPtyRendererDeliveryDebugSnapshot,
  setLocalPtyProvider
} from './pty'

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
    mainWindow,
    createMockProc,
    getPtyAckDataListener,
    DELIVERY_RESYNC_UNANSWERED_WARNING,
    countResyncUnansweredWarnings,
    getPtyDataSendCalls,
    getDeliveryResyncProbeCalls,
    getDeliveryResyncResponseListener,
    spawnAndSaturateRendererDeliveryGate
  } = setupPtyIpcSuite()

  it('self-heals lost ACKs when a later cumulative ACK arrives', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      expect(getPtyDataSendCalls()).toHaveLength(32)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        rendererInFlightPtyCount: 1
      })

      // Every per-chunk ACK was lost, but the next ACK carries the full cumulative total — the debt clears without any timer or reset.
      const ackData = getPtyAckDataListener()
      ackData(null, { id: spawnResult.id, processedChars: 512 * 1024 })

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0
      })

      vi.runOnlyPendingTimers()
      expect(getPtyDataSendCalls()).toHaveLength(33)
    } finally {
      vi.useRealTimers()
    }
  })
  it('applies cumulative ACKs idempotently and ignores stale reordered totals', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      const ackData = getPtyAckDataListener()

      ackData(null, { id: spawnResult.id, processedChars: 256 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 256 * 1024,
        maxRendererInFlightCharsByPty: 256 * 1024
      })

      // Replayed duplicate credits nothing further.
      ackData(null, { id: spawnResult.id, processedChars: 256 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 256 * 1024
      })

      // A stale reordered total can never move accounting backwards.
      ackData(null, { id: spawnResult.id, processedChars: 128 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 256 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps zero, duplicate, and stale ACKs to one legacy no-write timer', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      const ackData = getPtyAckDataListener()
      expect(getPtyDataSendCalls()).toHaveLength(32)
      expect(vi.getTimerCount()).toBe(0)

      ackData(null, { id: spawnResult.id, processedChars: 0 })
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(true)
      expect(vi.getTimerCount()).toBe(1)
      ackData(null, { id: spawnResult.id, processedChars: 0 })
      ackData(null, { id: spawnResult.id, processedChars: -1 })
      expect(vi.getTimerCount()).toBe(1)

      vi.runOnlyPendingTimers()
      expect(getPtyDataSendCalls()).toHaveLength(32)
      expect(getPtyRendererDeliveryDebugSnapshot().flushScheduled).toBe(false)
      expect(vi.getTimerCount()).toBe(0)

      ackData(null, { id: spawnResult.id, processedChars: 16 * 1024 })
      vi.runOnlyPendingTimers()
      expect(getPtyDataSendCalls()).toHaveLength(33)
    } finally {
      vi.useRealTimers()
    }
  })
  it('tolerates mixed legacy delta and cumulative ACK payloads', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      const ackData = getPtyAckDataListener()

      // Legacy delta shape (no processedChars) still credits per chunk.
      ackData(null, { id: spawnResult.id, charCount: 16 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 496 * 1024
      })

      // A cumulative total then supersedes without double-crediting the delta.
      ackData(null, { id: spawnResult.id, processedChars: 512 * 1024 })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('forwards only newly acknowledged cumulative bytes to provider ACK backpressure', async () => {
    vi.useFakeTimers()
    const acknowledgeDataEvent = vi.fn()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      setLocalPtyProvider({
        spawn: vi.fn(async () => ({ id: 'cumulative-pty' })),
        write: vi.fn(),
        resize: vi.fn(),
        shutdown: vi.fn(),
        sendSignal: vi.fn(),
        getCwd: vi.fn(),
        getInitialCwd: vi.fn(),
        clearBuffer: vi.fn(),
        acknowledgeDataEvent,
        hasChildProcesses: vi.fn(),
        getForegroundProcess: vi.fn(),
        serialize: vi.fn(),
        revive: vi.fn(),
        onData: vi.fn((callback) => {
          mockProc.proc.onData((data: string) => callback({ id: 'cumulative-pty', data }))
          return () => {}
        }),
        onReplay: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {}),
        listProcesses: vi.fn(async () => []),
        attach: vi.fn(),
        getDefaultShell: vi.fn(),
        getProfiles: vi.fn()
      } as never)
      registerPtyHandlers(mainWindow as never)
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('remote-output')
      vi.advanceTimersByTime(8)

      // Why: cumulative totals clamp to what main sent; a replayed total credits SSH/relay flow control 0, not duplicate bytes.
      ackData(null, { id: 'cumulative-pty', processedChars: 1024 })
      ackData(null, { id: 'cumulative-pty', processedChars: 1024 })

      expect(acknowledgeDataEvent).toHaveBeenNthCalledWith(
        1,
        'cumulative-pty',
        'remote-output'.length
      )
      expect(acknowledgeDataEvent).toHaveBeenNthCalledWith(2, 'cumulative-pty', 0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('probes for a delivery resync when data arrives for a fully gated PTY and reconciles on reply', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)

      mockProc.emitData('stuck-output')
      expect(getDeliveryResyncProbeCalls()).toHaveLength(1)
      const probePayload = getDeliveryResyncProbeCalls()[0]![1] as { requestId: number }

      // Only one probe may be outstanding at a time.
      mockProc.emitData('still-stuck')
      expect(getDeliveryResyncProbeCalls()).toHaveLength(1)

      const respondDeliveryResync = getDeliveryResyncResponseListener()
      respondDeliveryResync(null, {
        requestId: probePayload.requestId,
        processedCharsByPty: { [spawnResult.id]: 512 * 1024 }
      })

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 0,
        rendererInFlightPtyCount: 0
      })

      // Reconciled gate lets held pendingData flush again (one 2ms batch window = one 16KB slice).
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toHaveLength(33)
    } finally {
      vi.useRealTimers()
    }
  })
  it('ignores resync replies with stale request ids', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      const spawnResult = await spawnAndSaturateRendererDeliveryGate(mockProc)
      mockProc.emitData('stuck-output')
      const probePayload = getDeliveryResyncProbeCalls()[0]![1] as { requestId: number }

      const respondDeliveryResync = getDeliveryResyncResponseListener()
      respondDeliveryResync(null, {
        requestId: probePayload.requestId + 41,
        processedCharsByPty: { [spawnResult.id]: 512 * 1024 }
      })

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('clears an unanswered resync probe, warns once per silent streak, and never mutates counters', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      await spawnAndSaturateRendererDeliveryGate(mockProc)

      mockProc.emitData('stuck-output')
      expect(getDeliveryResyncProbeCalls()).toHaveLength(1)

      vi.advanceTimersByTime(4_999)
      expect(countResyncUnansweredWarnings(warnSpy)).toBe(0)

      vi.advanceTimersByTime(1)
      expect(countResyncUnansweredWarnings(warnSpy)).toBe(1)
      expect(warnSpy).toHaveBeenCalledWith(
        DELIVERY_RESYNC_UNANSWERED_WARNING,
        expect.objectContaining({
          rendererInFlightChars: 512 * 1024,
          pendingPtyCount: 1
        })
      )
      // No blind reset: counters and pending output are untouched.
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024,
        pendingChars: 88 * 1024 + 'stuck-output'.length
      })
      expect(getPtyDataSendCalls()).toHaveLength(32)

      // Cleared flag lets the next gated arrival probe again, but a still-silent renderer won't spam a second warn.
      mockProc.emitData('still-stuck')
      expect(getDeliveryResyncProbeCalls()).toHaveLength(2)
      vi.advanceTimersByTime(5_000)
      expect(countResyncUnansweredWarnings(warnSpy)).toBe(1)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        rendererInFlightChars: 512 * 1024
      })
    } finally {
      warnSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
