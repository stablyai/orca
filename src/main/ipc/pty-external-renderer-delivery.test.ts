import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock, removeHandlerMock, removeAllListenersMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/tmp/orca-pty-external-delivery-test',
    getVersion: () => '0.0.0-test'
  },
  powerMonitor: { on: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('../pwsh', () => ({ isPwshAvailable: vi.fn(() => false) }))

import { LocalPtyProvider } from '../providers/local-pty-provider'
import { registerPtyHandlers, setLocalPtyProvider } from './pty'
import {
  routeExternalPtyData,
  routeExternalPtyExit,
  routeExternalPtyReplay
} from './pty-renderer-delivery-router'

describe('external PTY renderer delivery', () => {
  const mainWindow = {
    isDestroyed: () => false,
    isFocused: () => true,
    isVisible: () => true,
    isMinimized: () => false,
    webContents: {
      on: vi.fn(),
      send: vi.fn(),
      removeListener: vi.fn(),
      isLoadingMainFrame: vi.fn(() => true)
    }
  }
  const mainWindowEvent = { sender: mainWindow.webContents }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    onMock.mockImplementation((channel: string, listener: (...args: unknown[]) => void) => {
      if (channel === 'pty:rendererDispatcherReady') {
        listener(mainWindowEvent)
        vi.advanceTimersByTime(0)
      }
    })
  })

  afterEach(() => {
    setLocalPtyProvider(new LocalPtyProvider())
    vi.useRealTimers()
  })

  function findIpcListener(channel: string): (...args: never[]) => void {
    const call = onMock.mock.calls.findLast(([registered]) => registered === channel)
    if (!call) {
      throw new Error(`Missing ${channel} listener`)
    }
    return call[1] as (...args: never[]) => void
  }

  function makeRuntime(sequence = 17) {
    return {
      setPtyController: vi.fn(),
      onPtyData: vi.fn(() => sequence),
      getPtyOutputSequence: vi.fn(() => sequence),
      hasRawTerminalViewSubscriber: vi.fn(() => false)
    }
  }

  it('returns captured SSH credit only after the renderer acknowledges parsing', () => {
    const runtime = makeRuntime()
    const upstreamCredit = { charCount: 9, acknowledge: vi.fn() }
    registerPtyHandlers(mainWindow as never, runtime as never)
    mainWindow.webContents.send.mockClear()

    routeExternalPtyData({
      id: 'ssh:target@@pty-1',
      data: '',
      sequenceChars: 9,
      transformed: true,
      upstreamCredit
    })
    vi.advanceTimersByTime(2)

    expect(runtime.onPtyData).toHaveBeenCalledWith(
      'ssh:target@@pty-1',
      '',
      expect.any(Number),
      9,
      true
    )
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:data', {
      id: 'ssh:target@@pty-1',
      data: '',
      seq: 17,
      rawLength: 9,
      transformed: true
    })
    expect(upstreamCredit.acknowledge).not.toHaveBeenCalled()

    findIpcListener('pty:ackData')(
      mainWindowEvent as never,
      {
        id: 'ssh:target@@pty-1',
        processedChars: 9
      } as never
    )

    expect(upstreamCredit.acknowledge).toHaveBeenCalledOnce()
    expect(upstreamCredit.acknowledge).toHaveBeenCalledWith(9)
  })

  it('returns credit immediately when hidden output is intentionally dropped', () => {
    const runtime = makeRuntime(42)
    const upstreamCredit = { charCount: 13, acknowledge: vi.fn() }
    registerPtyHandlers(mainWindow as never, runtime as never)
    findIpcListener('pty:setHiddenRendererPty')(
      null as never,
      {
        id: 'ssh:target@@pty-hidden',
        hidden: true
      } as never
    )
    mainWindow.webContents.send.mockClear()

    routeExternalPtyData({
      id: 'ssh:target@@pty-hidden',
      data: 'hidden output',
      upstreamCredit
    })

    expect(runtime.onPtyData).toHaveBeenCalledOnce()
    expect(upstreamCredit.acknowledge).toHaveBeenCalledWith(13)
    expect(mainWindow.webContents.send).toHaveBeenCalledOnce()
    expect(mainWindow.webContents.send).toHaveBeenCalledWith('pty:modelRestoreNeeded', {
      id: 'ssh:target@@pty-hidden',
      reason: 'hidden-drop',
      markerSeq: 42
    })
  })

  it('settles queued live credit when a reconnect replay supersedes it', () => {
    const runtime = makeRuntime()
    const upstreamCredit = { charCount: 11, acknowledge: vi.fn() }
    registerPtyHandlers(mainWindow as never, runtime as never)
    mainWindow.webContents.send.mockClear()

    routeExternalPtyData({
      id: 'ssh:target@@pty-replay',
      data: 'queued live',
      upstreamCredit
    })
    routeExternalPtyReplay({ id: 'ssh:target@@pty-replay', data: 'full snapshot' })
    vi.advanceTimersByTime(10)

    expect(upstreamCredit.acknowledge).toHaveBeenCalledWith(11)
    expect(mainWindow.webContents.send.mock.calls).toEqual([
      ['pty:replay', { id: 'ssh:target@@pty-replay', data: 'full snapshot' }]
    ])
  })

  it('writes off captured in-flight credit when the renderer lifecycle ends', () => {
    const runtime = makeRuntime()
    const upstreamCredit = { charCount: 7, acknowledge: vi.fn() }
    registerPtyHandlers(mainWindow as never, runtime as never)
    routeExternalPtyData({
      id: 'ssh:target@@pty-reload',
      data: 'inflight',
      upstreamCredit
    })
    vi.advanceTimersByTime(2)
    expect(upstreamCredit.acknowledge).not.toHaveBeenCalled()

    const lifecycleCall = mainWindow.webContents.on.mock.calls.findLast(
      ([event]) => event === 'did-start-loading'
    )
    const handleLifecycleReset = lifecycleCall?.[1] as (() => void) | undefined
    expect(handleLifecycleReset).toBeTypeOf('function')
    handleLifecycleReset?.()

    expect(upstreamCredit.acknowledge).toHaveBeenCalledWith(7)
  })

  it('settles queued final-tail credit when exit flushes before the batch timer', () => {
    const runtime = makeRuntime()
    const upstreamCredit = { charCount: 10, acknowledge: vi.fn() }
    registerPtyHandlers(mainWindow as never, runtime as never)
    mainWindow.webContents.send.mockClear()

    routeExternalPtyData({
      id: 'ssh:target@@pty-final-tail',
      data: 'final tail',
      upstreamCredit
    })
    routeExternalPtyExit({ id: 'ssh:target@@pty-final-tail', code: 0 })

    expect(upstreamCredit.acknowledge).toHaveBeenCalledWith(10)
    expect(mainWindow.webContents.send.mock.calls).toEqual([
      [
        'pty:data',
        {
          id: 'ssh:target@@pty-final-tail',
          data: 'final tail',
          seq: 17,
          rawLength: 10
        }
      ],
      ['pty:exit', { id: 'ssh:target@@pty-final-tail', code: 0 }]
    ])
  })

  it('settles already-sent credit when exit arrives before renderer ACK', () => {
    const runtime = makeRuntime()
    const upstreamCredit = { charCount: 8, acknowledge: vi.fn() }
    registerPtyHandlers(mainWindow as never, runtime as never)

    routeExternalPtyData({
      id: 'ssh:target@@pty-inflight-exit',
      data: 'inflight',
      upstreamCredit
    })
    vi.advanceTimersByTime(2)
    expect(upstreamCredit.acknowledge).not.toHaveBeenCalled()

    routeExternalPtyExit({ id: 'ssh:target@@pty-inflight-exit', code: 0 })

    expect(upstreamCredit.acknowledge).toHaveBeenCalledWith(8)
  })
})
