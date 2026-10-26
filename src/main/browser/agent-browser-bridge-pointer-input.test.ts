import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
    stdinWrites: [] as string[]
  }))

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))
vi.mock('os', () => ({ platform: () => 'darwin', arch: () => 'arm64' }))
vi.mock('electron', () => {
  return {
    app: {
      getPath: vi.fn(() => '/app'),
      getAppPath: vi.fn(() => '/project'),
      isPackaged: false
    },
    webContents: { fromId: webContentsFromIdMock }
  }
})
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  const MockClass = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    _wc: unknown
  ) {
    this._wc = _wc
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})

vi.mock('./cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))
vi.mock('./cdp-bridge', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

function recordDispatchedEvents(
  wc: ReturnType<typeof mockWebContents>,
  sink: Record<string, unknown>[]
): void {
  wc.debugger.sendCommand.mockImplementation(async (method, params) => {
    if (method === 'Input.dispatchMouseEvent' && typeof params === 'object' && params !== null) {
      sink.push({ ...params })
    }
    return {}
  })
}

describe('AgentBrowserBridge coordinate pointer input', () => {
  let bridge: AgentBrowserBridge
  let wc: ReturnType<typeof mockWebContents>
  let dispatchedEvents: Record<string, unknown>[]

  const dispatched = (): Record<string, unknown>[] => dispatchedEvents

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
    wc = mockWebContents(100)
    dispatchedEvents = []
    recordDispatchedEvents(wc, dispatchedEvents)
    webContentsFromIdMock.mockReturnValue(wc)
  })

  it('sends CDP payloads matching a real pointer press and release', async () => {
    await bridge.mouseMove(10, 20)
    await bridge.mouseDown('left')
    await bridge.mouseUp('left')

    expect(dispatched()).toEqual([
      { type: 'mouseMoved', x: 10, y: 20, button: 'none', buttons: 0 },
      {
        type: 'mousePressed',
        x: 10,
        y: 20,
        button: 'left',
        buttons: 1,
        clickCount: 1
      },
      {
        type: 'mouseReleased',
        x: 10,
        y: 20,
        button: 'left',
        buttons: 0,
        clickCount: 1
      }
    ])
  })

  it('drags from the tracked position while the button stays held', async () => {
    await bridge.mouseMove(10, 20)
    await bridge.mouseDown('left')
    await bridge.mouseMove(60, 80)

    expect(dispatched()[2]).toEqual({
      type: 'mouseMoved',
      x: 60,
      y: 80,
      button: 'left',
      buttons: 1
    })
  })

  it('scrolls at the tracked pointer position, not the origin', async () => {
    await bridge.mouseMove(300, 400)
    await bridge.mouseWheel(120)

    expect(dispatched()[1]).toEqual({
      type: 'mouseWheel',
      x: 300,
      y: 400,
      deltaX: 0,
      deltaY: 120,
      buttons: 0
    })
  })

  it('keeps pointer state per tab', async () => {
    const other = mockWebContents(200)
    recordDispatchedEvents(other, [])

    await bridge.mouseMove(10, 20)
    webContentsFromIdMock.mockReturnValue(other)
    await bridge.mouseMove(90, 90)
    webContentsFromIdMock.mockReturnValue(wc)
    await bridge.mouseDown('left')

    expect(dispatched()[1]).toMatchObject({
      type: 'mousePressed',
      x: 10,
      y: 20
    })
  })

  it('escalates clickCount for a repeat press at the same point', async () => {
    // A wall-clock stall over 500ms resets click cadence.
    vi.useFakeTimers()
    try {
      await bridge.mouseMove(10, 20)
      for (let i = 0; i < 4; i += 1) {
        await bridge.mouseDown('left')
        await bridge.mouseUp('left')
      }
    } finally {
      vi.useRealTimers()
    }

    expect(
      dispatched()
        .filter((event) => event.type === 'mousePressed')
        .map((event) => event.clickCount)
    ).toEqual([1, 2, 3, 1])
  })

  it('restarts clickCount when the second press lands elsewhere', async () => {
    vi.useFakeTimers()
    try {
      await bridge.mouseMove(10, 20)
      await bridge.mouseDown('left')
      await bridge.mouseUp('left')
      await bridge.mouseMove(400, 400)
      await bridge.mouseDown('left')
    } finally {
      vi.useRealTimers()
    }

    expect(dispatched().at(-1)).toMatchObject({
      type: 'mousePressed',
      clickCount: 1
    })
  })

  it('restarts clickCount when the repeat press uses another button', async () => {
    vi.useFakeTimers()
    try {
      await bridge.mouseMove(10, 20)
      await bridge.mouseDown('left')
      await bridge.mouseUp('left')
      await bridge.mouseDown('right')
    } finally {
      vi.useRealTimers()
    }

    expect(dispatched().at(-1)).toMatchObject({
      type: 'mousePressed',
      button: 'right',
      clickCount: 1
    })
  })

  it('restarts clickCount once the repeat lands outside the double-click interval', async () => {
    vi.useFakeTimers()
    try {
      await bridge.mouseMove(10, 20)
      await bridge.mouseDown('left')
      await bridge.mouseUp('left')
      vi.setSystemTime(Date.now() + 501)
      await bridge.mouseDown('left')
    } finally {
      vi.useRealTimers()
    }

    expect(dispatched().at(-1)).toMatchObject({
      type: 'mousePressed',
      clickCount: 1
    })
  })

  it('carries back and forward through as X1 and X2 presses', async () => {
    await bridge.mouseDown('back')
    await bridge.mouseUp('back')
    await bridge.mouseDown('forward')

    expect(dispatched()).toEqual([
      {
        type: 'mousePressed',
        x: 0,
        y: 0,
        button: 'back',
        buttons: 8,
        clickCount: 1
      },
      {
        type: 'mouseReleased',
        x: 0,
        y: 0,
        button: 'back',
        buttons: 0,
        clickCount: 1
      },
      {
        type: 'mousePressed',
        x: 0,
        y: 0,
        button: 'forward',
        buttons: 16,
        clickCount: 1
      }
    ])
  })

  it('releases the held button when mouseUp names none', async () => {
    await bridge.mouseDown('right')
    await bridge.mouseUp()

    expect(dispatched().at(-1)).toMatchObject({
      type: 'mouseReleased',
      button: 'right',
      buttons: 0
    })
  })

  it('keeps the remaining held button addressable after a chorded release', async () => {
    await bridge.mouseDown('left')
    await bridge.mouseDown('right')
    await bridge.mouseUp('right')
    await bridge.mouseUp()

    expect(dispatched()[2]).toMatchObject({
      type: 'mouseReleased',
      button: 'right',
      buttons: 1
    })
    expect(dispatched()[3]).toMatchObject({
      type: 'mouseReleased',
      button: 'left',
      buttons: 0
    })
  })

  it('defaults to left when nothing is held and mouseUp names no button', async () => {
    await bridge.mouseUp()

    expect(dispatched()[0]).toMatchObject({
      type: 'mouseReleased',
      button: 'left',
      buttons: 0
    })
  })

  it('rejects non-finite coordinates and deltas before dispatching', async () => {
    await expect(bridge.mouseMove(Number.NaN, 20)).rejects.toMatchObject({
      code: 'browser_error'
    })
    await expect(bridge.mouseWheel(Number.POSITIVE_INFINITY)).rejects.toMatchObject({
      code: 'browser_error'
    })

    expect(dispatched()).toHaveLength(0)
  })

  it('reports a page that dies mid-dispatch as browser_tab_not_found', async () => {
    wc.debugger.sendCommand.mockImplementation(async () => {
      webContentsFromIdMock.mockReturnValue(null)
      throw new Error('Debugger is not attached to the target')
    })

    await expect(bridge.mouseDown('left')).rejects.toMatchObject({
      code: 'browser_tab_not_found'
    })
  })

  it('leaves no phantom held button when a press fails to dispatch', async () => {
    await bridge.mouseMove(10, 20)
    wc.debugger.sendCommand.mockRejectedValueOnce(new Error('boom'))
    await expect(bridge.mouseDown('left')).rejects.toThrow()
    await bridge.mouseMove(30, 40)

    expect(dispatched().at(-1)).toEqual({
      type: 'mouseMoved',
      x: 30,
      y: 40,
      button: 'none',
      buttons: 0
    })
  })

  it('rewinds the tracked position when a move fails to dispatch', async () => {
    await bridge.mouseMove(10, 20)
    wc.debugger.sendCommand.mockRejectedValueOnce(new Error('boom'))
    await expect(bridge.mouseMove(300, 400)).rejects.toThrow()
    await bridge.mouseWheel(120)

    expect(dispatched().at(-1)).toMatchObject({ type: 'mouseWheel', x: 10, y: 20 })
  })

  it('does not count a failed press toward the double-click cadence', async () => {
    await bridge.mouseMove(10, 20)
    wc.debugger.sendCommand.mockRejectedValueOnce(new Error('boom'))
    await expect(bridge.mouseDown('left')).rejects.toThrow()
    await bridge.mouseDown('left')

    expect(dispatched().at(-1)).toMatchObject({ type: 'mousePressed', clickCount: 1 })
  })

  it('attaches and detaches the debugger around each dispatch', async () => {
    let attached = false
    wc.debugger.isAttached.mockImplementation(() => attached)
    wc.debugger.attach.mockImplementation(() => {
      attached = true
    })

    await bridge.mouseMove(10, 20)

    expect(wc.debugger.attach).toHaveBeenCalledWith('1.3')
    expect(wc.debugger.detach).toHaveBeenCalled()
  })

  it('leaves a debugger it did not attach alone', async () => {
    await bridge.mouseMove(10, 20)

    expect(wc.debugger.attach).not.toHaveBeenCalled()
    expect(wc.debugger.detach).not.toHaveBeenCalled()
  })

  it('guards the user’s focus instead of focusing an embedded guest on press', async () => {
    const release = vi.fn()
    const guardUserFocusForAgentInput = vi.fn(async () => release)
    bridge = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { guardUserFocusForAgentInput })
    )
    bridge.setActiveTab(100)
    wc.getType.mockReturnValue('webview')

    await bridge.mouseDown('left')
    await bridge.mouseUp('left')

    expect(wc.focus).not.toHaveBeenCalled()
    expect(guardUserFocusForAgentInput).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
