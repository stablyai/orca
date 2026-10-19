import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers } from './pty/register-handlers'

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

  /** Registers the handlers against the suite's mock window and spawns one daemon PTY. */
  async function registerAndSpawnDaemonPty(runtime: Record<string, unknown>): Promise<string> {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's mock window and this runtime stub implement every member the spawn path touches.
    registerPtyHandlers(mainWindow as never, runtime as never)
    const spawn = handlers.get('pty:spawn')
    if (!spawn) {
      throw new Error('missing pty:spawn handler')
    }
    const result: unknown = await spawn(null, {
      cols: 80,
      rows: 24,
      sessionId: 'daemon-session'
    })
    if (
      !result ||
      typeof result !== 'object' ||
      !('id' in result) ||
      typeof result.id !== 'string'
    ) {
      throw new Error('pty:spawn returned no id')
    }
    return result.id
  }

  /** The drop episode main put on its most recent restore marker. */
  function lastMarkerEpisode(): number {
    const markers = mainWindow.webContents.send.mock.calls.filter(
      (call: unknown[]) => call[0] === 'pty:modelRestoreNeeded'
    )
    const payload: unknown = markers.at(-1)?.[1]
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('hiddenDropEpisode' in payload) ||
      typeof payload.hiddenDropEpisode !== 'number'
    ) {
      throw new Error('no restore marker carried a drop episode')
    }
    return payload.hiddenDropEpisode
  }

  /** One gated drop episode on a fresh daemon PTY, with the marker count reset. */
  async function armDropLatch(): Promise<{
    id: string
    setHidden: (event: unknown, args: { id: string; hidden: boolean }) => void
    restoreMarkers: () => number
  }> {
    const daemon = installObservableDaemonTestProvider()
    const result = { id: await registerAndSpawnDaemonPty(buildRuntime()) }
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
        hiddenDropEpisode: expect.any(Number),
        reason: 'unhide',
        markerSeq: 42
      })

      // Serving the snapshot proves only that main answered — the asking pane
      // can still die before it paints.
      await getSnapshot(null, { id })
      setHidden(null, { id, hidden: false })
      expect(restoreMarkers()).toBe(4)

      // The ack says the bytes are on screen: no marker storm afterwards.
      ackApplied(null, { id, hiddenDropEpisode: lastMarkerEpisode() })
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
      const result = { id: await registerAndSpawnDaemonPty(buildRuntime()) }
      const setHidden = getPtySetHiddenRendererPtyListener()
      const ackApplied = getPtyHiddenOutputRestoreAppliedListener()
      mainWindow.webContents.send.mockClear()

      setHidden(null, { id: result.id, hidden: true })
      daemon.emitData(result.id, 'hidden output')
      vi.advanceTimersByTime(50)
      setHidden(null, { id: result.id, hidden: false })
      ackApplied(null, { id: result.id, hiddenDropEpisode: lastMarkerEpisode() })

      setHidden(null, { id: result.id, hidden: true })
      daemon.emitData(result.id, 'hidden again')
      vi.advanceTimersByTime(50)

      // hidden-drop, unhide, then the fresh episode's hidden-drop.
      expect(
        mainWindow.webContents.send.mock.calls.filter(
          (call: unknown[]) => call[0] === 'pty:modelRestoreNeeded'
        ).length
      ).toBe(3)
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

      // An ack naming no episode, or a stale one, cannot prove it covered this gap.
      ackApplied(null, { id })
      ackApplied(null, { id, hiddenDropEpisode: lastMarkerEpisode() - 1 })
      setHidden(null, { id, hidden: false })
      expect(restoreMarkers()).toBe(3)

      const episode = lastMarkerEpisode()
      ackApplied(null, { id, hiddenDropEpisode: episode })
      ackApplied(null, { id, hiddenDropEpisode: episode })
      setHidden(null, { id, hidden: false })
      expect(restoreMarkers()).toBe(3)
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
      const result = { id: await registerAndSpawnDaemonPty(runtime) }
      const setHidden = getPtySetHiddenRendererPtyListener()
      mainWindow.webContents.send.mockClear()

      setHidden(null, { id: result.id, hidden: true })
      daemon.emitData(result.id, 'hidden output')
      vi.advanceTimersByTime(50)

      // Why: a refused snapshot painted nothing, so the next reveal still owes
      // the renderer a restore signal.
      expect(
        await handlers.get('pty:getMainBufferSnapshot')!(null, {
          id: result.id
        })
      ).toBeNull()
      setHidden(null, { id: result.id, hidden: false })
      expect(mainWindow.webContents.send).toHaveBeenLastCalledWith('pty:modelRestoreNeeded', {
        id: result.id,
        hiddenDropEpisode: expect.any(Number),
        reason: 'unhide',
        markerSeq: 42
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
