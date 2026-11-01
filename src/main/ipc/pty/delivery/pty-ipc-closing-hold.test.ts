import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { TerminalIntentionalStops } from '../../../runtime/terminal-intentional-stops'
import { restorePtyIncarnation } from '../provider/ownership-state'
import { clearProviderPtyState } from '../provider/state-cleanup'

// A whole-tab close (a terminal→chat switch) holds its process's teardown output from the pane it
// removes: never queued or charged, the stream's sequence kept, and restored if the stop isn't proven.
const PTY_ID = 'daemon-session'

describe('output of a process a whole-tab close is stopping', () => {
  const { handlers, mainWindow, installObservableDaemonTestProvider } = setupPtyIpcSuite()

  async function closing() {
    vi.useFakeTimers()
    let seq = 0
    const stops = new TerminalIntentionalStops()
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
      registerPreAllocatedHandleForPty: vi.fn(),
      intentionalPtyStops: stops
    }
    const daemon = installObservableDaemonTestProvider()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the suite's window and runtime stubs cover every member registerPtyHandlers reads.
    registerPtyHandlers(mainWindow as never, runtime as never)
    await handlers.get('pty:spawn')!(null, { cols: 80, rows: 24, sessionId: PTY_ID })
    restorePtyIncarnation(PTY_ID, 'incarnation-1')
    const emit = (data: string) => {
      daemon.emitData(PTY_ID, data)
      vi.advanceTimersByTime(50)
    }
    const sent = (channel: string) =>
      mainWindow.webContents.send.mock.calls
        .filter(([name]) => name === channel)
        .map(([, payload]): Record<string, unknown> => payload)
    const settle = stops.mark(PTY_ID, 'closing', 'incarnation-1')
    mainWindow.webContents.send.mockClear()
    return { emit, sent, settle, seq: () => seq }
  }

  afterEach(() => {
    // The process's exit clears its held output; these fakes never exit.
    clearProviderPtyState(PTY_ID)
    vi.useRealTimers()
  })

  it('never shows or charges the teardown output once the stop is proven', async () => {
    const pane = await closing()
    pane.emit('zsh: terminated  codex resume\r\n% ')
    pane.settle(true)
    // A late byte from the same process inside the exit window stays held too.
    pane.emit('\r\n')
    expect(pane.sent('pty:data')).toEqual([])
    expect(pane.sent('pty:modelRestoreNeeded')).toEqual([])
  })

  it('restores the pane before output resumes when the stop was not proven', async () => {
    const pane = await closing()
    pane.emit('held while stopping')
    const heldThrough = pane.seq()
    pane.settle(false)
    pane.emit('still running')
    expect(pane.sent('pty:modelRestoreNeeded')).toEqual([
      { id: PTY_ID, reason: 'pending-cap', markerSeq: heldThrough }
    ])
    // The stream's sequence still counts the held bytes; only the resumed bytes are delivered.
    expect(pane.sent('pty:data')).toEqual([
      expect.objectContaining({ data: 'still running', seq: pane.seq(), rawLength: 13 })
    ])
    const order = mainWindow.webContents.send.mock.calls.map(([name]) => name)
    expect(order.indexOf('pty:modelRestoreNeeded')).toBeLessThan(order.indexOf('pty:data'))
  })

  it('restores the pane when the unproven stop settles, though the process stays quiet', async () => {
    const pane = await closing()
    pane.emit('held while stopping')
    const heldThrough = pane.seq()
    pane.settle(false)
    expect(pane.sent('pty:modelRestoreNeeded')).toEqual([
      { id: PTY_ID, reason: 'pending-cap', markerSeq: heldThrough }
    ])
    pane.emit('still running')
    expect(pane.sent('pty:modelRestoreNeeded')).toHaveLength(1)
  })

  it('never holds a later process that reuses the id', async () => {
    const pane = await closing()
    pane.settle(true)
    restorePtyIncarnation(PTY_ID, 'incarnation-2')
    pane.emit('a new shell')
    expect(pane.sent('pty:data')).toEqual([expect.objectContaining({ data: 'a new shell' })])
  })
})
