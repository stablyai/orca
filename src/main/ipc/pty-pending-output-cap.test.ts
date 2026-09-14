import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { acceptSshPtyOutputData } from './ssh-pty-output-intake-registry'
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

      // Saturate the renderer in-flight window (512 KB) with no ACKs — the frozen/starved-renderer shape from field reports.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }

      // Keep flooding past the 2 MB per-PTY pending cap; main must not buffer unboundedly (previously: unbounded string concat).
      mockProc.emitData('y'.repeat(3 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })

      // Later output while dropped must stay O(1), not start re-accumulating.
      mockProc.emitData('z'.repeat(64 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })

      // On recover+ACK, the flush must deliver the droppedOutput sentinel so the pane repaints from the main-owned snapshot.
      mainWindow.webContents.send.mockClear()
      ackData(null, { id: spawn.id, charCount: 512 * 1024 })
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawn.id,
        data: '',
        droppedOutput: true
      })

      // Fresh output after the sentinel flows normally again.
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

      // Saturate the in-flight window with no ACKs, then buffer 3 MB — over the floor, under the scaled cap: retain, don't drop.
      mockProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 32; index++) {
        vi.advanceTimersByTime(1)
      }
      mockProc.emitData('y'.repeat(3 * 1024 * 1024))
      expect(getPtyRendererDeliveryDebugSnapshot().pendingChars).toBeGreaterThan(3 * 1024 * 1024)

      // The scaled cap still bounds a runaway flood.
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

      // Flood in 64KB chunks like a `yes`-style producer honoring pause — node-pty pause() stops the fd read, so it stops emitting.
      const chunk = 'x'.repeat(64 * 1024)
      let chunks = 0
      while (provider.pauseProducer.mock.calls.length === 0 && chunks < 100) {
        provider.emitData('flood-pty', chunk)
        chunks++
      }

      // Pause fires exactly once, on the first chunk past the 256KB high watermark (the 5th 64KB chunk), not per chunk.
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(provider.pauseProducer).toHaveBeenCalledWith('flood-pty')
      expect(chunks).toBe(5)
      // Bounded: main buffered at most HIGH + one chunk while paused.
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 320 * 1024,
        peakPendingChars: 320 * 1024
      })

      // Resume must fire exactly once at the 32KB low watermark, with no flapping across the 32-256KB hysteresis band.
      vi.runAllTimers()
      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(provider.resumeProducer).toHaveBeenCalledWith('flood-pty')
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({ pendingChars: 0 })
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps negotiated source-credit overflow off the legacy PTY-global pause path', async () => {
    vi.useFakeTimers()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const provider = installObservableDaemonTestProvider()
      let modelSequence = 0
      const runtime = {
        setPtyController: vi.fn(),
        setRemoteTerminalSourceRangeConsumerHooks: vi.fn(),
        getPtyOutputSequence: vi.fn(() => modelSequence),
        onPtyData: vi.fn(
          (_id: string, data: string, _at: number, rawLength = data.length) =>
            (modelSequence += rawLength)
        ),
        acceptPtyDataBounded: vi.fn(
          (_id: string, _data: string, _at: number, rawLength: number) => {
            modelSequence += rawLength
            return { sequence: modelSequence, completion: Promise.resolve() }
          }
        )
      }
      registerPtyHandlers(mainWindow as never, runtime as never)
      mainWindow.webContents.send.mockClear()

      const sourceChunk = 's'.repeat(128 * 1024)
      for (let index = 0; index < 17; index++) {
        const sourceStartSu = index * sourceChunk.length
        await acceptSshPtyOutputData({
          id: 'source-credit-pty',
          data: sourceChunk,
          providerGeneration: 41,
          ptyIncarnation: 'source-incarnation',
          rawLength: sourceChunk.length,
          transformed: false,
          source: {
            relayPtyId: 'relay-source-pty',
            spanId: `source-token:${sourceStartSu}:${sourceStartSu + sourceChunk.length}`,
            clientGeneration: 2,
            ownerGeneration: 3,
            deliveryToken: 'source-token',
            sourceStartSu,
            sourceEndSu: sourceStartSu + sourceChunk.length
          }
        })
      }

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 0
      })
      expect(provider.pauseProducer).not.toHaveBeenCalledWith('source-credit-pty')
      expect(provider.resumeProducer).not.toHaveBeenCalledWith('source-credit-pty')

      provider.emitData('legacy-pty', 'l'.repeat(320 * 1024))
      expect(provider.pauseProducer).toHaveBeenCalledTimes(1)
      expect(provider.pauseProducer).toHaveBeenCalledWith('legacy-pty')
      expect(provider.pauseProducer).not.toHaveBeenCalledWith('unrelated-pty')

      vi.runAllTimers()
      expect(provider.resumeProducer).toHaveBeenCalledTimes(1)
      expect(provider.resumeProducer).toHaveBeenCalledWith('legacy-pty')
    } finally {
      errorSpy.mockRestore()
      vi.useRealTimers()
    }
  })
})
