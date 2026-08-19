import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from './pty-ipc-mock-registry'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'

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
    getPtyAckDataListener,
    getPtyDataSendCalls,
    getDeliveryResyncProbeCalls
  } = setupPtyIpcSuite()

  it('forwards only actually in-flight bytes to provider ACK backpressure', async () => {
    vi.useFakeTimers()
    const acknowledgeDataEvent = vi.fn()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      setLocalPtyProvider({
        spawn: vi.fn(async () => ({ id: 'remote-like-pty' })),
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
          mockProc.proc.onData((data: string) => callback({ id: 'remote-like-pty', data }))
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
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: 'remote-like-pty',
        data: 'remote-output'
      })

      // Why: stale/duplicated renderer ACKs must not over-credit SSH/relay flow control beyond bytes main sent.
      ackData(null, { id: 'remote-like-pty', charCount: 1024 })
      ackData(null, { id: 'remote-like-pty', charCount: 1024 })

      expect(acknowledgeDataEvent).toHaveBeenNthCalledWith(
        1,
        'remote-like-pty',
        'remote-output'.length
      )
      expect(acknowledgeDataEvent).toHaveBeenNthCalledWith(2, 'remote-like-pty', 0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('reserves a bounded renderer lane for interactive output when bulk output is saturated', async () => {
    vi.useFakeTimers()
    const bulkProcs = Array.from({ length: 16 }, () => createMockProc())
    const interactiveProc = createMockProc()
    for (const proc of [...bulkProcs, interactiveProc]) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      for (const _proc of bulkProcs) {
        await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp'
        })
      }
      const interactiveSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const writeListener = getPtyWriteListener()
      mainWindow.webContents.send.mockClear()

      for (const proc of bulkProcs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(512)
      expect(vi.getTimerCount()).toBe(0)

      writeListener(mainWindowIpcEvent, {
        id: interactiveSpawn.id,
        data: 'a'
      })
      interactiveProc.emitData('\x1b[20;2Hredraw')

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(513)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(513, 'pty:data', {
        id: interactiveSpawn.id,
        data: '\x1b[20;2Hredraw'
      })

      const reservePrefix = '\x1b[20;2H'
      const reserveChunk = `${reservePrefix}${'r'.repeat(16 * 1024 - reservePrefix.length)}`
      for (let index = 0; index < 16; index++) {
        writeListener(mainWindowIpcEvent, {
          id: interactiveSpawn.id,
          data: 'a'
        })
        interactiveProc.emitData(reserveChunk)
      }
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(529)

      writeListener(mainWindowIpcEvent, {
        id: interactiveSpawn.id,
        data: 'a'
      })
      interactiveProc.emitData(reserveChunk)
      // Why: reserve-exhausted send stays gated, and the fully gated arrival emits one delivery resync probe (not pty:data).
      expect(getPtyDataSendCalls()).toHaveLength(529)
      expect(getDeliveryResyncProbeCalls()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('caps total renderer in-flight output across many PTYs', async () => {
    vi.useFakeTimers()
    const procs = Array.from({ length: 17 }, () => createMockProc())
    for (const proc of procs) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      const spawns: { id: string }[] = []
      for (const _proc of procs) {
        spawns.push(
          (await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd: '/tmp'
          })) as { id: string }
        )
      }
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      for (const proc of procs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(512)
      ackData(null, { id: spawns[0].id, charCount: 16 * 1024 })
      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(513)
    } finally {
      vi.useRealTimers()
    }
  })
  it('reactivates every globally blocked PTY when an exit releases renderer credit', async () => {
    vi.useFakeTimers()
    const procs = Array.from({ length: 17 }, () => createMockProc())
    for (const proc of procs) {
      spawnMock.mockReturnValueOnce(proc.proc)
    }

    try {
      registerPtyHandlers(mainWindow as never)
      const spawns: { id: string }[] = []
      for (const _proc of procs) {
        spawns.push(
          (await handlers.get('pty:spawn')!(null, {
            cols: 80,
            rows: 24,
            cwd: '/tmp'
          })) as { id: string }
        )
      }
      mainWindow.webContents.send.mockClear()
      for (const proc of procs) {
        proc.emitData('x'.repeat(600 * 1024))
      }
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 400; index++) {
        vi.advanceTimersByTime(1)
      }
      expect(getPtyDataSendCalls()).toHaveLength(512)
      expect(vi.getTimerCount()).toBe(0)

      mainWindow.webContents.send.mockClear()
      procs[0]!.emitExit(0)
      const exitIndex = mainWindow.webContents.send.mock.calls.findIndex(
        (call) => call[0] === 'pty:exit'
      )
      expect(exitIndex).toBeGreaterThanOrEqual(0)
      vi.advanceTimersByTime(0)

      expect(
        mainWindow.webContents.send.mock.calls
          .slice(exitIndex + 1)
          .some(
            (call) =>
              call[0] === 'pty:data' &&
              (call[1] as { id?: string } | undefined)?.id !== spawns[0]!.id
          )
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
