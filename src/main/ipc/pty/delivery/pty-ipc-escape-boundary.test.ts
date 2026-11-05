import { describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import { registerPtyHandlers } from '../register-handlers'

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
vi.mock('../../../pty/shell-startup/pwsh', () =>
  import('../pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../../wsl/filesystem/unc-path-access', async (importOriginal) =>
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
vi.mock('../../../codex/configuration/homes/codex-pane-account-registry', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../../codex/history/index/codex-state-db-backfill-recovery', () =>
  import('../pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)
// The observable daemon provider adopts the spawn's sessionId as the PTY id.
const PTY_ID = 'daemon-session'

describe('the first delivery after a hidden drop (#33766)', () => {
  const {
    handlers,
    mainWindow,
    installObservableDaemonTestProvider,
    getPtySetHiddenRendererPtyListener
  } = setupPtyIpcSuite()

  async function hideDropAndResume(dropped: string, resumed: string) {
    vi.useFakeTimers()
    let seq = 0
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn((_id: string, _data: string, _at: number, chars: number) => (seq += chars)),
      getPtyOutputSequence: vi.fn(() => seq),
      hasRemoteTerminalViewSubscriber: vi.fn(() => false),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      registerPreAllocatedHandleForPty: vi.fn()
    }
    const daemon = installObservableDaemonTestProvider()
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's window and runtime stubs cover every member registerPtyHandlers reads.
      registerPtyHandlers(mainWindow as never, runtime as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, sessionId: PTY_ID })
      const id = PTY_ID
      const setHidden = getPtySetHiddenRendererPtyListener()
      setHidden(null, { id, hidden: true })
      daemon.emitData(id, dropped)
      vi.advanceTimersByTime(50)
      setHidden(null, { id, hidden: false })
      mainWindow.webContents.send.mockClear()
      daemon.emitData(id, resumed)
      vi.advanceTimersByTime(50)
      const delivered = mainWindow.webContents.send.mock.calls
        .filter(([channel]) => channel === 'pty:data')
        .map(([, payload]): Record<string, unknown> => payload)
      return { delivered, seq }
    } finally {
      vi.useRealTimers()
    }
  }

  it.each([
    [
      'an OSC title',
      'done\x1b]0;Sequent',
      'ial refactoring PRs | cleanup-dumb-exports\x07> prompt',
      '\x1b]'
    ],
    ['an SGR sequence', 'diff \x1b[38;5', ';242m+ line', '\x1b['],
    ['a CSI whose ESC alone was dropped', 'diff \x1b', '[38;5;242m+ line', '\x1b']
  ])(
    'marks the first delivery after a drop that split %s, without trimming it',
    async (_name, dropped, resumed) => {
      const { delivered, seq } = await hideDropAndResume(dropped, resumed)
      // A restore whose snapshot carries the open escape still needs every continuation byte.
      expect(delivered).toEqual([
        { id: expect.any(String), data: resumed, seq, rawLength: resumed.length, midEscape: true }
      ])
    }
  )

  it('leaves a delivery after a clean drop boundary unmarked, including a bell after text', async () => {
    const { delivered } = await hideDropAndResume('hidden\x1b[0m', 'build done\x07')
    expect(delivered.map((payload) => payload.data).join('')).toBe('build done\x07')
    expect(delivered.some((payload) => 'midEscape' in payload)).toBe(false)
  })
})

describe('deliveries across a gap main did not see in full', () => {
  const {
    handlers,
    mainWindow,
    installObservableDaemonTestProvider,
    getPtySetHiddenRendererPtyListener
  } = setupPtyIpcSuite()

  type Drive = {
    emit: (data: string, extra?: { sequenceChars?: number }) => void
    gap: (droppedChars: number) => void
    setHidden: (hidden: boolean) => void
    flush: () => void
    clearDelivered: () => void
  }

  async function deliveredAfter(script: (drive: Drive) => void) {
    vi.useFakeTimers()
    let seq = 0
    const runtime = {
      setPtyController: vi.fn(),
      registerPty: vi.fn(),
      noteTerminalSpawnCommand: vi.fn(),
      onPtySpawned: vi.fn(),
      onPtyExit: vi.fn(),
      onPtyData: vi.fn((_id: string, _data: string, _at: number, chars: number) => (seq += chars)),
      notePtyDataGap: vi.fn((_id: string, chars: number) => (seq += chars)),
      getPtyOutputSequence: vi.fn(() => seq),
      hasRemoteTerminalViewSubscriber: vi.fn(() => false),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      registerPreAllocatedHandleForPty: vi.fn()
    }
    const daemon = installObservableDaemonTestProvider()
    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's window and runtime stubs cover every member registerPtyHandlers reads.
      registerPtyHandlers(mainWindow as never, runtime as never)
      await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, sessionId: PTY_ID })
      const setHidden = getPtySetHiddenRendererPtyListener()
      script({
        emit: (data, extra) => daemon.emitData(PTY_ID, data, extra),
        gap: (droppedChars) => daemon.emitDataGap(PTY_ID, droppedChars),
        setHidden: (hidden) => setHidden(null, { id: PTY_ID, hidden }),
        flush: () => vi.advanceTimersByTime(50),
        clearDelivered: () => mainWindow.webContents.send.mockClear()
      })
      return mainWindow.webContents.send.mock.calls
        .filter(([channel]) => channel === 'pty:data')
        .map(([, payload]): Record<string, unknown> => payload)
    } finally {
      vi.useRealTimers()
    }
  }

  it('marks the tail the daemon kept after thinning, until the stream reaches an escape', async () => {
    const delivered = await deliveredAfter((drive) => {
      drive.emit('\x1b[46;3H')
      drive.flush()
      drive.clearDelivered()
      // The daemon dropped `\x1b[H\r\x1b[15C\x1b[` from Claude's spinner frame.
      drive.gap(12)
      drive.emit('42B\x1b[K\x1b[50;1H\x1b[46;3H')
      drive.flush()
      drive.emit('next frame')
      drive.flush()
    })
    expect(delivered.map((payload) => [payload.data, payload.midEscape])).toEqual([
      ['42B\x1b[K\x1b[50;1H\x1b[46;3H', 'unknown'],
      ['next frame', undefined]
    ])
  })

  it('turns a batch still queued at a daemon gap into the drop sentinel', async () => {
    const delivered = await deliveredAfter((drive) => {
      // Still batching when the daemon reports bytes it thinned after this output.
      drive.emit('frame \x1b[6n\x1b[')
      drive.gap(12)
      drive.emit('42Bdone')
      drive.flush()
    })
    // The queued query survives; output around the gap restores from the daemon's snapshot.
    expect(delivered).toEqual([{ id: PTY_ID, data: '\x1b[6n', droppedOutput: true }])
  })

  it('delivers query copies salvaged from a daemon gap as drop-sentinel recovery bytes', async () => {
    const delivered = await deliveredAfter((drive) => {
      drive.emit('\x1b[46;3H')
      drive.flush()
      drive.clearDelivered()
      drive.gap(12)
      drive.emit('\x1b[6n', { sequenceChars: 0 })
      drive.flush()
      drive.emit('42B\x1b[K')
      drive.flush()
    })
    expect(delivered).toEqual([
      { id: PTY_ID, data: '\x1b[6n', droppedOutput: true },
      expect.objectContaining({ data: '42B\x1b[K', midEscape: 'unknown' })
    ])
  })

  it('drops a kept tail that joins the query copies within the same interval', async () => {
    const delivered = await deliveredAfter((drive) => {
      drive.emit('\x1b[46;3H')
      drive.flush()
      drive.clearDelivered()
      drive.gap(12)
      drive.emit('\x1b[6n', { sequenceChars: 0 })
      drive.emit('42B\x1b[K')
      drive.flush()
    })
    // The tail follows lost bytes either way; the restore that the gap requested repaints it.
    expect(delivered).toEqual([{ id: PTY_ID, data: '\x1b[6n', droppedOutput: true }])
  })
})
