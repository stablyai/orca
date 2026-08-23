import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty'

// STA-4869 — main's hidden-delivery drop latch retires on the renderer's
// applied-ack, never on serving the snapshot. Serving proves only that main
// answered: the pane can dispose across the multi-MB serialize + IPC round trip
// (tab/split/worktree switch, renderer reload), and a snapshot nobody painted
// heals nothing. Anything that retires the latch earlier spends the last
// recovery signal on a marker no view will ever receive.

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

describe('registerPtyHandlers hidden-output restore ack', () => {
  const {
    handlers,
    mainWindow,
    installObservableDaemonTestProvider,
    getPtySetHiddenRendererPtyListener,
    getPtyHiddenOutputRestoreAppliedListener
  } = setupPtyIpcSuite()

  function buildRuntime(): Record<string, unknown> {
    return {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn(() => 42),
      getPtyOutputSequence: vi.fn(() => 42),
      hasRemoteTerminalViewSubscriber: vi.fn(() => false),
      createPreAllocatedTerminalHandle: vi.fn(() => 'terminal-handle-1'),
      registerPreAllocatedHandleForPty: vi.fn(),
      serializeHiddenOutputRecoveryBuffer: vi.fn(async () => ({
        data: 'retained while hidden',
        cols: 80,
        rows: 24,
        seq: 42
      }))
    }
  }

  /** One gated drop episode on a fresh daemon PTY, with the marker count reset. */
  async function armDropLatch(): Promise<{
    id: string
    setHidden: (event: unknown, args: { id: string; hidden: boolean }) => void
    restoreMarkers: () => number
  }> {
    const daemon = installObservableDaemonTestProvider()
    registerPtyHandlers(mainWindow as never, buildRuntime() as never)
    const result = (await handlers.get('pty:spawn')!(null, {
      cols: 80,
      rows: 24,
      sessionId: 'daemon-session'
    })) as { id: string }
    const setHidden = getPtySetHiddenRendererPtyListener()
    mainWindow.webContents.send.mockClear()

    setHidden(null, { id: result.id, hidden: true })
    daemon.emitData(result.id, 'hidden output')
    vi.advanceTimersByTime(50)
    const restoreMarkers = (): number =>
      mainWindow.webContents.send.mock.calls.filter(
        (call: unknown[]) => call[0] === 'pty:modelRestoreNeeded'
      ).length
    expect(restoreMarkers()).toBe(1)
    return { id: result.id, setHidden, restoreMarkers }
  }

  it('retires drop memory on the applied ack, not on unhide or on serving the snapshot', async () => {
    vi.useFakeTimers()
    try {
      const { id, setHidden, restoreMarkers } = await armDropLatch()
      const getSnapshot = handlers.get('pty:getMainBufferSnapshot')!
      const ackApplied = getPtyHiddenOutputRestoreAppliedListener()

      // A pane retiring while hidden unhides after unregistering its marker
      // handler, so the first unhide marker reaches nobody. The replacement's
      // own unhide must still be able to ask for the restore.
      setHidden(null, { id, hidden: false })
      setHidden(null, { id, hidden: false })
      expect(restoreMarkers()).toBe(3)
      expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
        id,
        reason: 'unhide',
        markerSeq: 42
      })

      // Serving the snapshot proves only that main answered — the asking pane
      // can still die before it paints.
      await getSnapshot(null, { id })
      setHidden(null, { id, hidden: false })
      expect(restoreMarkers()).toBe(4)

      // The ack says the bytes are on screen: no marker storm afterwards.
      ackApplied(null, { id })
      setHidden(null, { id, hidden: false })
      setHidden(null, { id, hidden: false })
      expect(restoreMarkers()).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-arms the marker for a fresh drop episode after the ack', async () => {
    vi.useFakeTimers()
    try {
      const daemon = installObservableDaemonTestProvider()
      registerPtyHandlers(mainWindow as never, buildRuntime() as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'daemon-session'
      })) as { id: string }
      const setHidden = getPtySetHiddenRendererPtyListener()
      const ackApplied = getPtyHiddenOutputRestoreAppliedListener()
      mainWindow.webContents.send.mockClear()

      setHidden(null, { id: result.id, hidden: true })
      daemon.emitData(result.id, 'hidden output')
      vi.advanceTimersByTime(50)
      ackApplied(null, { id: result.id })
      setHidden(null, { id: result.id, hidden: false })

      setHidden(null, { id: result.id, hidden: true })
      daemon.emitData(result.id, 'hidden again')
      vi.advanceTimersByTime(50)

      expect(
        mainWindow.webContents.send.mock.calls.filter(
          (call: unknown[]) => call[0] === 'pty:modelRestoreNeeded'
        ).length
      ).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a repeat ack and an ack for a PTY it knows nothing about', async () => {
    vi.useFakeTimers()
    try {
      const { id, setHidden, restoreMarkers } = await armDropLatch()
      const ackApplied = getPtyHiddenOutputRestoreAppliedListener()

      // Another pane's ack must never retire this PTY's drop memory.
      ackApplied(null, { id: 'some-other-pty' })
      ackApplied(null, {})
      ackApplied(null, { id: '' })
      ackApplied(null, { id: 42 })
      setHidden(null, { id, hidden: false })
      expect(restoreMarkers()).toBe(2)

      ackApplied(null, { id })
      ackApplied(null, { id })
      setHidden(null, { id, hidden: false })
      expect(restoreMarkers()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps drop memory armed when the snapshot is refused', async () => {
    vi.useFakeTimers()
    try {
      const daemon = installObservableDaemonTestProvider()
      const runtime = buildRuntime()
      runtime.serializeHiddenOutputRecoveryBuffer = vi.fn(async () => null)
      registerPtyHandlers(mainWindow as never, runtime as never)
      const result = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        sessionId: 'daemon-session'
      })) as { id: string }
      const setHidden = getPtySetHiddenRendererPtyListener()
      mainWindow.webContents.send.mockClear()

      setHidden(null, { id: result.id, hidden: true })
      daemon.emitData(result.id, 'hidden output')
      vi.advanceTimersByTime(50)

      // Why: a refused snapshot painted nothing, so the next reveal still owes
      // the renderer a restore signal.
      expect(await handlers.get('pty:getMainBufferSnapshot')!(null, { id: result.id })).toBeNull()
      setHidden(null, { id: result.id, hidden: false })
      expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
        id: result.id,
        reason: 'unhide',
        markerSeq: 42
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
