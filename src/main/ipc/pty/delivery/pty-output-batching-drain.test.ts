import { describe, expect, it, vi } from 'vitest'
import { spawnMock } from '../pty-ipc-mock-registry'
import { setupPtyIpcSuite } from '../pty-ipc-test-harness'
import { registerPtyHandlers } from '../register-handlers'
import { setLocalPtyProvider } from '../provider/registry'
import { getPtyRendererDeliveryDebugSnapshot, resetPtyRendererDeliveryDebug } from './debug'

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
  const { handlers, mainWindow, mainWindowIpcEvent, createMockProc, getPtyWriteListener } =
    setupPtyIpcSuite()

  it('accepts source-classified daemon startup spans before spawn resolves', async () => {
    vi.useFakeTimers()
    type ProviderData = {
      id: string
      data: string
      sequenceChars?: number
      transformed?: boolean
      seq?: number
    }
    let dataHandler: ((payload: ProviderData) => void) | null = null
    const write = vi.fn()
    const query = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
    const spawn = vi.fn(async (options: { sessionId?: string; startupIngress?: unknown }) => {
      const id = options.sessionId ?? 'daemon-pty'
      dataHandler?.({
        id,
        data: '',
        sequenceChars: query.length,
        transformed: true,
        seq: query.length
      })
      dataHandler?.({ id, data: 'daemon-ready' })
      return { id }
    })
    setLocalPtyProvider({
      spawn,
      write,
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn((handler: (payload: ProviderData) => void) => {
        dataHandler = handler
        return () => {}
      }),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)

    try {
      let seq = 0
      const runtime = {
        setPtyController: vi.fn(),
        createPreAllocatedTerminalHandle: vi.fn(() => null),
        onPtyData: vi.fn(
          (_id: string, _data: string, _at: number, rawLength: number) => (seq += rawLength)
        ),
        registerPty: vi.fn()
      }
      registerPtyHandlers(mainWindow as never, runtime as never)
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

      expect(spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          startupIngress: expect.objectContaining({
            colors: { foreground: '#eeeeee', background: '#111111' },
            deadlineMs: 5_000
          })
        })
      )
      expect(write).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'daemon-ready',
        seq: query.length + 'daemon-ready'.length,
        rawLength: query.length + 'daemon-ready'.length,
        transformed: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('preserves source raw sequence metadata when a consumed query is batched', async () => {
    vi.useFakeTimers()
    type ProviderData = {
      id: string
      data: string
      sequenceChars?: number
      transformed?: boolean
      seq?: number
    }
    const providerEvents: {
      dataHandler?: (payload: ProviderData) => void
    } = {}
    const write = vi.fn()
    const spawn = vi.fn(async (options: { sessionId?: string }) => ({
      id: options.sessionId ?? 'daemon-pty'
    }))
    setLocalPtyProvider({
      spawn,
      write,
      resize: vi.fn(),
      kill: vi.fn(),
      shutdown: vi.fn(),
      sendSignal: vi.fn(),
      getCwd: vi.fn(),
      getInitialCwd: vi.fn(),
      clearBuffer: vi.fn(),
      acknowledgeDataEvent: vi.fn(),
      hasChildProcesses: vi.fn(),
      getForegroundProcess: vi.fn(),
      serialize: vi.fn(),
      revive: vi.fn(),
      onData: vi.fn((handler: (payload: ProviderData) => void) => {
        providerEvents.dataHandler = handler
        return () => {}
      }),
      onReplay: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      listProcesses: vi.fn(async () => []),
      attach: vi.fn(),
      getDefaultShell: vi.fn(),
      getProfiles: vi.fn()
    } as never)
    let seq = 0
    const runtime = {
      setPtyController: vi.fn(),
      createPreAllocatedTerminalHandle: vi.fn(() => null),
      onPtyData: vi.fn((_id: string, data: string, _at: number, rawLength = data.length) => {
        seq += rawLength
        return seq
      }),
      registerPty: vi.fn()
    }

    try {
      registerPtyHandlers(mainWindow as never, runtime as never)
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
      mainWindow.webContents.send.mockClear()

      providerEvents.dataHandler?.({ id: spawnResult.id, data: 'prefix' })
      const query = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\'
      providerEvents.dataHandler?.({
        id: spawnResult.id,
        data: '',
        sequenceChars: query.length,
        transformed: true,
        seq: 'prefix'.length + query.length
      })
      providerEvents.dataHandler?.({ id: spawnResult.id, data: 'ready' })
      vi.advanceTimersByTime(2)

      expect(write).not.toHaveBeenCalled()
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: 'prefixready',
        seq: 'prefix'.length + query.length + 'ready'.length,
        rawLength: 'prefix'.length + query.length + 'ready'.length,
        transformed: true
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('sends small PTY redraws immediately after terminal input', async () => {
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
      const writeListener = getPtyWriteListener()

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      mockProc.emitData('\x1b[20;2Hredraw')

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: '\x1b[20;2Hredraw'
      })
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('ignores PTY input for unknown sessions', async () => {
    vi.useFakeTimers()
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })
      const writeListener = getPtyWriteListener()

      writeListener(mainWindowIpcEvent, {
        id: 'missing-pty',
        data: 'a'
      })

      expect(mockProc.proc.write).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it('batches large PTY output even after recent terminal input', async () => {
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
      const writeListener = getPtyWriteListener()

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      const largeOutput = 'x'.repeat(1025)
      mockProc.emitData(largeOutput)

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: largeOutput
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('batches repeated small PTY chunks after the interactive output budget is exhausted', async () => {
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
      const writeListener = getPtyWriteListener()

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      const smallChunk = 'x'.repeat(512)
      for (let index = 0; index < 65; index++) {
        mockProc.emitData(smallChunk)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(64)
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(65)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(65, 'pty:data', {
        id: spawnResult.id,
        data: smallChunk
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('sends larger ANSI redraws immediately after terminal input', async () => {
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
      const writeListener = getPtyWriteListener()

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      mainWindow.webContents.send.mockClear()

      const redraw = `\x1b[2J\x1b[H${'codex composer redraw '.repeat(80)}`
      mockProc.emitData(redraw)

      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: redraw
      })
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('batches combined pending output that exceeds the interactive size limit', async () => {
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
      const writeListener = getPtyWriteListener()
      mainWindow.webContents.send.mockClear()

      const pendingOutput = 'x'.repeat(1020)
      mockProc.emitData(pendingOutput)
      expect(mainWindow.webContents.send).not.toHaveBeenCalled()

      writeListener(mainWindowIpcEvent, {
        id: spawnResult.id,
        data: 'a'
      })
      mockProc.emitData('redraw')

      expect(mainWindow.webContents.send).not.toHaveBeenCalled()
      vi.advanceTimersByTime(2)
      expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
        id: spawnResult.id,
        data: `${pendingOutput}redraw`
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PTY bounded output draining', () => {
  const {
    handlers,
    mainWindow,
    createMockProc,
    installObservableDaemonTestProvider,
    getPtyAckDataListener,
    getPtySetActiveRendererPtyListener,
    getMainFrameNavigationListener,
    getPtyDataSendCalls
  } = setupPtyIpcSuite()

  it('drains large batched PTY output in bounded slices', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      mainWindow.webContents.send.mockClear()

      const firstChunk = 'x'.repeat(16 * 1024)
      const firstRemainder = 'tail'
      secondProc.emitData('second-terminal-output')
      firstProc.emitData(`${firstChunk}${firstRemainder}`)

      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(2)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(1, 'pty:data', {
        id: secondSpawn.id,
        data: 'second-terminal-output'
      })
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(2, 'pty:data', {
        id: firstSpawn.id,
        data: firstChunk
      })

      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(3)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(3, 'pty:data', {
        id: firstSpawn.id,
        data: firstRemainder
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('defers reentrant new, unvisited, and same-partial output to the next drain round', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    const newProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc)
    spawnMock.mockReturnValueOnce(secondProc.proc)
    spawnMock.mockReturnValueOnce(newProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const newSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const firstChunk = 'x'.repeat(16 * 1024)
      const setActiveRendererPty = getPtySetActiveRendererPtyListener()
      let reentered = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel !== 'pty:data' || payload.id !== firstSpawn.id || reentered) {
            return
          }
          reentered = true
          firstProc.emitData('+same')
          secondProc.emitData('+append')
          newProc.emitData('new')
          setActiveRendererPty(null, { id: newSpawn.id, active: true })
        }
      )

      firstProc.emitData(`${firstChunk}tail`)
      secondProc.emitData('second')
      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: firstSpawn.id, data: firstChunk }]])

      vi.advanceTimersByTime(2)
      expect(getPtyDataSendCalls().slice(1)).toEqual([
        ['pty:data', { id: newSpawn.id, data: 'new' }],
        ['pty:data', { id: secondSpawn.id, data: 'second+append' }]
      ])

      vi.advanceTimersByTime(1)
      expect(getPtyDataSendCalls().at(-1)).toEqual([
        'pty:data',
        { id: firstSpawn.id, data: 'tail+same' }
      ])
    } finally {
      vi.useRealTimers()
    }
  })
  it('commits a partial remainder before notification-reentrant exit', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string; incarnationId: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const firstChunk = 'x'.repeat(16 * 1024)
      mainWindow.webContents.send.mockClear()
      let exited = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string; data?: string }) => {
          if (
            channel === 'pty:data' &&
            payload.id === firstSpawn.id &&
            payload.data === firstChunk &&
            !exited
          ) {
            exited = true
            firstProc.emitExit(0)
          }
        }
      )

      firstProc.emitData(`${firstChunk}tail`)
      secondProc.emitData('next')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send.mock.calls).toEqual([
        ['pty:data', { id: firstSpawn.id, data: firstChunk }],
        ['pty:data', { id: firstSpawn.id, data: 'tail' }],
        [
          'pty:exit',
          {
            id: firstSpawn.id,
            code: 0,
            incarnationId: firstSpawn.incarnationId,
            hostId: 'local'
          }
        ],
        ['pty:data', { id: secondSpawn.id, data: 'next' }]
      ])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 1,
        rendererInFlightChars: 'next'.length,
        flushScheduled: false
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('aborts the open drain when renderer lifecycle clear reenters notification', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const detachedProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(detachedProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })
      const handleRendererLoading = getMainFrameNavigationListener()
      let cleared = false
      mainWindow.webContents.send.mockImplementation(
        (channel: string, payload: { id?: string }) => {
          if (channel === 'pty:data' && payload.id === firstSpawn.id && !cleared) {
            cleared = true
            handleRendererLoading()
          }
        }
      )

      firstProc.emitData('first')
      detachedProc.emitData('must-not-send')
      vi.advanceTimersByTime(2)

      expect(getPtyDataSendCalls()).toEqual([['pty:data', { id: firstSpawn.id, data: 'first' }]])
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        flushScheduled: false,
        rendererPtyDispatcherReady: false
      })
      expect(vi.getTimerCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('waits for renderer ACKs before sending more output for a saturated PTY', async () => {
    vi.useFakeTimers()
    const firstProc = createMockProc()
    const secondProc = createMockProc()
    spawnMock.mockReturnValueOnce(firstProc.proc).mockReturnValueOnce(secondProc.proc)

    try {
      registerPtyHandlers(mainWindow as never)
      const firstSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const secondSpawn = (await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp'
      })) as { id: string }
      const ackData = getPtyAckDataListener()
      mainWindow.webContents.send.mockClear()

      firstProc.emitData('x'.repeat(600 * 1024))
      vi.advanceTimersByTime(2)
      for (let index = 0; index < 31; index++) {
        vi.advanceTimersByTime(1)
      }

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      vi.advanceTimersByTime(1)
      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(32)
      expect(vi.getTimerCount()).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 88 * 1024,
        maxPendingCharsByPty: 88 * 1024,
        rendererInFlightPtyCount: 1,
        rendererInFlightChars: 512 * 1024,
        maxRendererInFlightCharsByPty: 512 * 1024,
        flushScheduled: false,
        peakPendingChars: 600 * 1024,
        peakMaxPendingCharsByPty: 600 * 1024,
        peakRendererInFlightChars: 512 * 1024,
        peakMaxRendererInFlightCharsByPty: 512 * 1024,
        ackGatedFlushSkipCount: 1
      })

      secondProc.emitData('second-terminal-output')
      vi.advanceTimersByTime(2)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(33)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(33, 'pty:data', {
        id: secondSpawn.id,
        data: 'second-terminal-output'
      })

      ackData(null, { id: firstSpawn.id, charCount: 16 * 1024 })
      vi.advanceTimersByTime(1)

      expect(mainWindow.webContents.send).toHaveBeenCalledTimes(34)
      expect(mainWindow.webContents.send).toHaveBeenNthCalledWith(34, 'pty:data', {
        id: firstSpawn.id,
        data: 'x'.repeat(16 * 1024)
      })
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 72 * 1024,
        rendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        peakPendingChars: 600 * 1024,
        peakRendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length
      })

      resetPtyRendererDeliveryDebug()

      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 1,
        pendingChars: 72 * 1024,
        rendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        peakPendingChars: 72 * 1024,
        peakMaxPendingCharsByPty: 72 * 1024,
        peakRendererInFlightChars: 512 * 1024 + 'second-terminal-output'.length,
        peakMaxRendererInFlightCharsByPty: 512 * 1024,
        ackGatedFlushSkipCount: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })
  it('does not scan delivery maps for 1,000 ACKs across 100 tracked PTYs', () => {
    vi.useFakeTimers()
    const provider = installObservableDaemonTestProvider()

    try {
      registerPtyHandlers(mainWindow as never)
      const ptyIds = Array.from({ length: 100 }, (_, index) => `pressure-pty-${index}`)
      for (const id of ptyIds) {
        provider.emitData(id, 'a')
      }
      vi.runAllTimers()
      for (const id of ptyIds) {
        provider.emitData(id, 'b')
      }
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 100,
        pendingChars: 100,
        rendererInFlightPtyCount: 100,
        rendererInFlightChars: 100
      })

      const ackData = getPtyAckDataListener()
      const mapValuesSpy = vi.spyOn(Map.prototype, 'values')
      let mapValuesCalls = 0
      try {
        for (let index = 0; index < 1_000; index++) {
          ackData(null, { id: ptyIds[0]!, processedChars: 1 })
        }
      } finally {
        mapValuesCalls = mapValuesSpy.mock.calls.length
        mapValuesSpy.mockRestore()
      }

      expect(mapValuesCalls).toBe(0)
      expect(getPtyRendererDeliveryDebugSnapshot()).toMatchObject({
        pendingPtyCount: 100,
        pendingChars: 100,
        rendererInFlightPtyCount: 99,
        rendererInFlightChars: 99
      })
    } finally {
      vi.useRealTimers()
    }
  })
})
