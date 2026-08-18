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
  createSucceedWith,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type MockWebContents
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

function keyEventCalls(wc: MockWebContents): [string, Record<string, unknown>][] {
  return wc.debugger.sendCommand.mock.calls.filter(
    (call) => call[0] === 'Input.dispatchKeyEvent'
  ) as [string, Record<string, unknown>][]
}

describe('AgentBrowserBridge keypress input', () => {
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

  it('dispatches a printable key over CDP without spawning agent-browser', async () => {
    await expect(bridge.keypress('a', undefined, 'tab-1')).resolves.toEqual({ pressed: 'a' })

    expect(execFileMock).not.toHaveBeenCalled()
    expect(CdpWsProxyMock.instances).toHaveLength(0)
    expect(keyEventCalls(wc)).toEqual([
      [
        'Input.dispatchKeyEvent',
        {
          type: 'keyDown',
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          key: 'a',
          code: 'KeyA',
          modifiers: 0,
          location: 0,
          text: 'a',
          unmodifiedText: 'a'
        }
      ],
      [
        'Input.dispatchKeyEvent',
        {
          type: 'keyUp',
          windowsVirtualKeyCode: 65,
          nativeVirtualKeyCode: 65,
          key: 'a',
          code: 'KeyA',
          modifiers: 0,
          location: 0
        }
      ]
    ])
  })

  it('types & as shifted 7 instead of colliding with the ArrowUp virtual key code', async () => {
    await bridge.keypress('&', undefined, 'tab-1')

    expect(keyEventCalls(wc)[0]?.[1]).toMatchObject({
      type: 'keyDown',
      windowsVirtualKeyCode: 55,
      modifiers: 8,
      text: '&'
    })
  })

  it('dispatches editing and navigation keys as rawKeyDown with no text', async () => {
    await bridge.keypress('ArrowDown', undefined, 'tab-1')

    expect(keyEventCalls(wc)[0]?.[1]).toMatchObject({
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 40,
      key: 'ArrowDown'
    })
    expect(keyEventCalls(wc)[0]?.[1]).not.toHaveProperty('text')
  })

  it('carries modifier masks for shortcuts', async () => {
    await expect(bridge.keypress('Ctrl+Shift+K', undefined, 'tab-1')).resolves.toEqual({
      pressed: 'Ctrl+Shift+K'
    })

    expect(keyEventCalls(wc)[0]?.[1]).toMatchObject({
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 75,
      modifiers: 10
    })
  })

  it('reports the modifier bit on a bare Shift keydown but not on its keyup', async () => {
    await bridge.keypress('Shift', undefined, 'tab-1')

    expect(keyEventCalls(wc)[0]?.[1]).toMatchObject({
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 16,
      code: 'ShiftLeft',
      modifiers: 8,
      location: 1
    })
    expect(keyEventCalls(wc)[1]?.[1]).toMatchObject({ type: 'keyUp', modifiers: 0, location: 1 })
  })

  it('keeps held modifiers on the keyup of a non-modifier shortcut key', async () => {
    await bridge.keypress('Ctrl+Shift+K', undefined, 'tab-1')

    expect(keyEventCalls(wc)[1]?.[1]).toMatchObject({ type: 'keyUp', modifiers: 10 })
  })

  it('presses Enter with its carriage-return text so fields submit', async () => {
    await bridge.keypress('Enter', undefined, 'tab-1')

    expect(keyEventCalls(wc)[0]?.[1]).toMatchObject({
      type: 'keyDown',
      windowsVirtualKeyCode: 13,
      text: '\r'
    })
  })

  it('dispatches a non-US printable character as an IME-style event in process', async () => {
    await expect(bridge.keypress('é', undefined, 'tab-1')).resolves.toEqual({ pressed: 'é' })

    expect(execFileMock).not.toHaveBeenCalled()
    expect(keyEventCalls(wc)[0]?.[1]).toMatchObject({
      type: 'keyDown',
      windowsVirtualKeyCode: 229,
      key: 'é',
      code: '',
      text: 'é',
      unmodifiedText: 'é'
    })
    expect(keyEventCalls(wc)[1]?.[1]).toMatchObject({ type: 'keyUp', windowsVirtualKeyCode: 229 })
  })

  it('keeps the helper for a surrogate-pair character', async () => {
    succeedWith({ pressed: '👍' })

    await expect(bridge.keypress('👍', undefined, 'tab-1')).resolves.toEqual({ pressed: '👍' })

    expect(keyEventCalls(wc)).toHaveLength(0)
  })

  it('falls back to agent-browser for a key name the table cannot express', async () => {
    succeedWith({ pressed: 'MediaPlayPause' })

    await expect(bridge.keypress('MediaPlayPause', undefined, 'tab-1')).resolves.toEqual({
      pressed: 'MediaPlayPause'
    })

    expect(keyEventCalls(wc)).toHaveLength(0)
    const pressCall = execFileMock.mock.calls.find((call: unknown[]) =>
      (call[1] as string[]).includes('press')
    )
    expect(pressCall).toBeDefined()
    const args = pressCall![1] as string[]
    expect(args[args.indexOf('press') + 1]).toBe('MediaPlayPause')
  })

  it('rejects with tab not found when the page is gone', async () => {
    webContentsFromIdMock.mockReturnValue(null)

    await expect(bridge.keypress('a', undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_tab_not_found'
    })
  })
})
