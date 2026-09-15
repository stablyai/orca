import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => {
    const stdinWrites: string[] = []

    return {
      execFileMock: vi.fn(),
      webContentsFromIdMock: vi.fn(),
      existsSyncMock: vi.fn(() => false),
      readFileSyncMock: vi.fn(() => Buffer.from('')),
      stdinWrites
    }
  })

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function keyEventCalls(wc: MockWebContents): Record<string, unknown>[] {
  return wc.debugger.sendCommand.mock.calls
    .filter(([method]) => method === 'Input.dispatchKeyEvent')
    .map(([, params]) => params)
    .filter(isRecord)
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
    // Why: exactly two CDP calls, so the dispatch pair is the whole interaction.
    expect(wc.debugger.sendCommand.mock.calls).toHaveLength(2)
    expect(keyEventCalls(wc)).toEqual([
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
      },
      {
        type: 'keyUp',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        key: 'a',
        code: 'KeyA',
        modifiers: 0,
        location: 0
      }
    ])
  })

  it('types & as shifted 7 instead of colliding with the ArrowUp virtual key code', async () => {
    await bridge.keypress('&', undefined, 'tab-1')

    expect(keyEventCalls(wc)[0]).toMatchObject({
      type: 'keyDown',
      windowsVirtualKeyCode: 55,
      modifiers: 8,
      text: '&'
    })
  })

  it('dispatches editing and navigation keys as rawKeyDown with no text', async () => {
    await bridge.keypress('ArrowDown', undefined, 'tab-1')

    expect(keyEventCalls(wc)[0]).toMatchObject({
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 40,
      key: 'ArrowDown'
    })
    expect(keyEventCalls(wc)[0]).not.toHaveProperty('text')
  })

  it('carries modifier masks for shortcuts', async () => {
    await expect(bridge.keypress('Ctrl+Shift+K', undefined, 'tab-1')).resolves.toEqual({
      pressed: 'Ctrl+Shift+K'
    })

    expect(keyEventCalls(wc)[0]).toMatchObject({
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 75,
      modifiers: 10
    })
  })

  it('reports the modifier bit on a bare Shift keydown but not on its keyup', async () => {
    await bridge.keypress('Shift', undefined, 'tab-1')

    expect(keyEventCalls(wc)[0]).toMatchObject({
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 16,
      code: 'ShiftLeft',
      modifiers: 8,
      location: 1
    })
    expect(keyEventCalls(wc)[1]).toMatchObject({ type: 'keyUp', modifiers: 0, location: 1 })
  })

  it('keeps held modifiers on the keyup of a non-modifier shortcut key', async () => {
    await bridge.keypress('Ctrl+Shift+K', undefined, 'tab-1')

    expect(keyEventCalls(wc)[1]).toMatchObject({ type: 'keyUp', modifiers: 10 })
  })

  it('presses Enter with its carriage-return text so fields submit', async () => {
    await bridge.keypress('Enter', undefined, 'tab-1')

    expect(keyEventCalls(wc)[0]).toMatchObject({
      type: 'keyDown',
      windowsVirtualKeyCode: 13,
      text: '\r'
    })
  })

  it('dispatches a non-US printable character as an IME-style event in process', async () => {
    await expect(bridge.keypress('é', undefined, 'tab-1')).resolves.toEqual({ pressed: 'é' })

    expect(execFileMock).not.toHaveBeenCalled()
    expect(keyEventCalls(wc)[0]).toMatchObject({
      type: 'keyDown',
      windowsVirtualKeyCode: 229,
      key: 'é',
      code: '',
      text: 'é',
      unmodifiedText: 'é'
    })
    expect(keyEventCalls(wc)[1]).toMatchObject({ type: 'keyUp', windowsVirtualKeyCode: 229 })
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

    const pressCall = execFileMock.mock.calls
      .map(([, commandArgs]) => commandArgs)
      .filter(isStringArray)
      .find((commandArgs) => commandArgs.includes('press'))

    expect(pressCall).toBeDefined()
    const args = pressCall ?? []
    expect(args[args.indexOf('press') + 1]).toBe('MediaPlayPause')
  })

  it('rejects with tab not found when the page is gone', async () => {
    webContentsFromIdMock.mockReturnValue(null)

    await expect(bridge.keypress('a', undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_tab_not_found'
    })
  })

  // Why: one keypress looks the page up three times — the queued target, the
  // automation-visibility refresh, then the dispatch guard. Serving the first N keeps the
  // later ones on the guard; the trailing assertions fail loudly if that count ever moves.
  function killPageAfterLookups(lookups: number): () => number {
    let remaining = lookups
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id !== 100 || remaining === 0) {
        return null
      }

      remaining -= 1

      return wc
    })

    return () => remaining
  }

  it('rejects with tab not found when the page dies after its target is resolved', async () => {
    const remaining = killPageAfterLookups(2)

    await expect(bridge.keypress('a', undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_tab_not_found'
    })
    expect(remaining()).toBe(0)
    expect(keyEventCalls(wc)).toHaveLength(0)
  })

  it('rejects with tab not found when the page dies mid-dispatch', async () => {
    const remaining = killPageAfterLookups(3)
    wc.debugger.sendCommand.mockRejectedValue(new Error('Inspected target navigated or closed'))

    await expect(bridge.keypress('a', undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_tab_not_found'
    })
    expect(remaining()).toBe(0)
  })

  it('reports a dispatch failure on a live page as a browser error', async () => {
    wc.debugger.sendCommand.mockRejectedValue(new Error('Debugger is not attached to the target'))

    await expect(bridge.keypress('a', undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_error',
      message: expect.stringContaining('Debugger is not attached to the target')
    })
  })

  it('reports a debugger attach failure as a browser error', async () => {
    wc.debugger.isAttached.mockReturnValue(false)
    wc.debugger.attach.mockImplementation(() => {
      throw new Error('Another debugger is already attached to the debug target')
    })

    await expect(bridge.keypress('a', undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_error'
    })
    expect(keyEventCalls(wc)).toHaveLength(0)
  })
})
