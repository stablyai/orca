import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
    app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
    webContents: { fromId: webContentsFromIdMock }
  }
})
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockClass = vi.fn().mockImplementation(function (this: any, _wc: unknown) {
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

import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type MockWebContents
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

function mouseEventCalls(wc: MockWebContents): [string, Record<string, unknown>][] {
  return wc.debugger.sendCommand.mock.calls.filter(
    (call) => call[0] === 'Input.dispatchMouseEvent'
  ) as [string, Record<string, unknown>][]
}

async function flushPendingDispatch(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('AgentBrowserBridge pointer input', () => {
  let bridge: AgentBrowserBridge
  let wc: MockWebContents

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
    wc.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockImplementation((id: number) => (id === 100 ? wc : null))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('dispatches mouse moves over CDP without spawning agent-browser', async () => {
    await expect(bridge.mouseMove(10, 20, undefined, 'tab-1')).resolves.toEqual({ moved: true })

    expect(execFileMock).not.toHaveBeenCalled()
    expect(mouseEventCalls(wc)).toEqual([
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20, button: 'none', buttons: 0 }]
    ])
  })

  it('presses at the position of the preceding mouse move', async () => {
    await bridge.mouseMove(10, 20, undefined, 'tab-1')
    await expect(bridge.mouseDown('left', undefined, 'tab-1')).resolves.toEqual({ pressed: true })

    expect(wc.focus).toHaveBeenCalled()
    expect(mouseEventCalls(wc)[1]?.[1]).toEqual({
      type: 'mousePressed',
      x: 10,
      y: 20,
      button: 'left',
      buttons: 1,
      clickCount: 1
    })
  })

  it('releases the held button and clears it from the buttons mask', async () => {
    await bridge.mouseMove(10, 20, undefined, 'tab-1')
    await bridge.mouseDown('left', undefined, 'tab-1')
    await expect(bridge.mouseUp(undefined, undefined, 'tab-1')).resolves.toEqual({
      released: true
    })

    expect(mouseEventCalls(wc)[2]?.[1]).toEqual({
      type: 'mouseReleased',
      x: 10,
      y: 20,
      button: 'left',
      buttons: 0,
      clickCount: 1
    })
  })

  it('reports a second click at the same point inside the interval as clickCount 2', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    await bridge.mouseMove(10, 20, undefined, 'tab-1')
    await bridge.mouseDown('left', undefined, 'tab-1')
    await bridge.mouseUp('left', undefined, 'tab-1')
    vi.setSystemTime(1_200)
    await bridge.mouseDown('left', undefined, 'tab-1')
    await bridge.mouseUp('left', undefined, 'tab-1')

    const presses = mouseEventCalls(wc).filter((call) => call[1].type === 'mousePressed')
    expect(presses[0]?.[1]).toMatchObject({ clickCount: 1 })
    expect(presses[1]?.[1]).toMatchObject({ clickCount: 2 })
    const releases = mouseEventCalls(wc).filter((call) => call[1].type === 'mouseReleased')
    expect(releases[1]?.[1]).toMatchObject({ clickCount: 2 })
  })

  it('resets the click count when the pointer moved away or the interval elapsed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)

    await bridge.mouseMove(10, 20, undefined, 'tab-1')
    await bridge.mouseDown('left', undefined, 'tab-1')
    await bridge.mouseUp('left', undefined, 'tab-1')
    await bridge.mouseMove(200, 20, undefined, 'tab-1')
    await bridge.mouseDown('left', undefined, 'tab-1')
    await bridge.mouseUp('left', undefined, 'tab-1')
    vi.setSystemTime(2_000)
    await bridge.mouseDown('left', undefined, 'tab-1')

    const presses = mouseEventCalls(wc).filter((call) => call[1].type === 'mousePressed')
    expect(presses.map((call) => call[1].clickCount)).toEqual([1, 1, 1])
  })

  it('dispatches wheel deltas at the tracked pointer position', async () => {
    await bridge.mouseMove(50, 60, undefined, 'tab-1')
    await expect(bridge.mouseWheel(120, 5, undefined, 'tab-1')).resolves.toEqual({
      scrolled: true,
      deltaX: 5,
      deltaY: 120
    })

    expect(execFileMock).not.toHaveBeenCalled()
    expect(mouseEventCalls(wc)[1]?.[1]).toEqual({
      type: 'mouseWheel',
      x: 50,
      y: 60,
      deltaX: 5,
      deltaY: 120,
      buttons: 0
    })
  })

  it('passes back and forward buttons through instead of coercing them to left', async () => {
    await bridge.mouseDown('back', undefined, 'tab-1')
    await bridge.mouseUp('back', undefined, 'tab-1')

    expect(mouseEventCalls(wc)[0]?.[1]).toMatchObject({
      type: 'mousePressed',
      button: 'back',
      buttons: 8
    })
    expect(mouseEventCalls(wc)[1]?.[1]).toMatchObject({
      type: 'mouseReleased',
      button: 'back',
      buttons: 0
    })
  })

  it('keeps the remaining held button active after a chorded release', async () => {
    await bridge.mouseDown('left', undefined, 'tab-1')
    await bridge.mouseDown('right', undefined, 'tab-1')
    await bridge.mouseUp('left', undefined, 'tab-1')
    await bridge.mouseUp(undefined, undefined, 'tab-1')

    const releases = mouseEventCalls(wc).filter((call) => call[1].type === 'mouseReleased')
    expect(releases[0]?.[1]).toMatchObject({ button: 'left', buttons: 2 })
    expect(releases[1]?.[1]).toMatchObject({ button: 'right', buttons: 0 })
  })

  it('restores pointer state after an un-awaited press failure', async () => {
    wc.debugger.sendCommand.mockRejectedValueOnce(new Error('target crashed'))

    await bridge.mouseDown('left', undefined, 'tab-1')
    await flushPendingDispatch()
    await expect(bridge.mouseDown('left', undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_error'
    })
    await bridge.mouseMove(10, 20, undefined, 'tab-1')

    expect(mouseEventCalls(wc).at(-1)?.[1]).toMatchObject({
      type: 'mouseMoved',
      button: 'none',
      buttons: 0
    })
  })

  it('lets a release retry succeed after an un-awaited release failure', async () => {
    await bridge.mouseDown('left', undefined, 'tab-1')
    wc.debugger.sendCommand.mockRejectedValueOnce(new Error('target crashed'))
    await bridge.mouseUp(undefined, undefined, 'tab-1')
    await flushPendingDispatch()
    await expect(bridge.mouseUp(undefined, undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_error'
    })
    await bridge.mouseUp(undefined, undefined, 'tab-1')

    const releases = mouseEventCalls(wc).filter((call) => call[1].type === 'mouseReleased')
    expect(releases.at(-1)?.[1]).toMatchObject({ button: 'left', buttons: 0 })
  })

  it('restores pointer state when an awaited dispatch rejects', async () => {
    vi.stubEnv('ORCA_BROWSER_INPUT_AWAIT_ACK', '1')
    wc.debugger.sendCommand.mockRejectedValueOnce(new Error('target crashed'))

    await expect(bridge.mouseDown('left', undefined, 'tab-1')).rejects.toThrow('target crashed')
    await bridge.mouseMove(10, 20, undefined, 'tab-1')

    expect(mouseEventCalls(wc).at(-1)?.[1]).toMatchObject({
      type: 'mouseMoved',
      button: 'none',
      buttons: 0
    })
  })

  it('rejects non-finite coordinates and deltas instead of dispatching them', async () => {
    await expect(bridge.mouseMove(Number.NaN, 20, undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_error'
    })
    await expect(bridge.mouseWheel(Infinity, 0, undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_error'
    })
    expect(mouseEventCalls(wc)).toHaveLength(0)
  })

  it('surfaces an un-awaited dispatch failure on the next pointer event', async () => {
    wc.debugger.sendCommand.mockRejectedValueOnce(new Error('target crashed'))

    await expect(bridge.mouseMove(10, 20, undefined, 'tab-1')).resolves.toEqual({ moved: true })
    await flushPendingDispatch()

    await expect(bridge.mouseMove(11, 21, undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_error',
      message: expect.stringContaining('target crashed')
    })
    await expect(bridge.mouseMove(12, 22, undefined, 'tab-1')).resolves.toEqual({ moved: true })
  })

  it('awaits the renderer ack and rejects in place when ORCA_BROWSER_INPUT_AWAIT_ACK=1', async () => {
    vi.stubEnv('ORCA_BROWSER_INPUT_AWAIT_ACK', '1')
    wc.debugger.sendCommand.mockRejectedValueOnce(new Error('target crashed'))

    await expect(bridge.mouseMove(10, 20, undefined, 'tab-1')).rejects.toThrow('target crashed')
  })

  it('tracks pointer position per tab', async () => {
    const otherWc = mockWebContents(101)
    otherWc.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 ? wc : id === 101 ? otherWc : null
    )
    bridge = new AgentBrowserBridge(
      mockBrowserManager(
        new Map([
          ['tab-1', 100],
          ['tab-2', 101]
        ])
      )
    )

    await bridge.mouseMove(10, 20, undefined, 'tab-1')
    await bridge.mouseMove(30, 40, undefined, 'tab-2')
    await bridge.mouseDown('left', undefined, 'tab-1')

    const press = mouseEventCalls(wc).find((call) => call[1].type === 'mousePressed')
    expect(press?.[1]).toMatchObject({ x: 10, y: 20 })
  })

  it('releases the debugger lease only after an in-flight dispatch settles', async () => {
    let attached = false
    wc.debugger.isAttached.mockImplementation(() => attached)
    wc.debugger.attach.mockImplementation(() => {
      attached = true
    })
    wc.debugger.detach.mockImplementation(() => {
      attached = false
    })
    let resolveDispatch!: () => void
    wc.debugger.sendCommand.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveDispatch = resolve
      })
    )

    await bridge.mouseMove(10, 20, undefined, 'tab-1')
    expect(wc.debugger.detach).not.toHaveBeenCalled()

    resolveDispatch()
    await flushPendingDispatch()
    expect(wc.debugger.detach).toHaveBeenCalled()
  })

  it('drops empty command queues after pointer dispatch finishes', async () => {
    await bridge.mouseMove(10, 20, undefined, 'tab-1')

    expect(
      (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
    ).toBe(0)
    expect((bridge as unknown as { processingQueues: Set<string> }).processingQueues.size).toBe(0)
  })
})
