import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
    stdinWrites: new Array<string>()
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
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
  webContents: { fromId: webContentsFromIdMock }
}))
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
vi.mock('./cdp-ws-proxy', () => ({ CdpWsProxy: CdpWsProxyMock }))

import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  captureRemoteCliBrowserScope,
  runInRemoteCliBrowserScope
} from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  assertRemoteCliPageAccess,
  runUnderRemoteCliPageAdmission
} from './remote-cli-page-admission'
import {
  createFakeAgentBrowserChild,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const WORKSPACE = 'repo-host::/srv/app'

/** Simulate a helper CDP step at the page proxy. */
function assertHelperStepAdmitted(): void {
  runUnderRemoteCliPageAdmission(100, () => assertRemoteCliPageAccess(100))
}

function dispatchedMouseEvents(wc: ReturnType<typeof mockWebContents>): unknown[] {
  return wc.debugger.sendCommand.mock.calls.filter((call) => call[0] === 'Input.dispatchMouseEvent')
}

describe('AgentBrowserBridge under a host revocation', () => {
  let bridge: AgentBrowserBridge

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
  })

  it('never presses the mouse once the host is revoked during a running click', async () => {
    const wc = mockWebContents(100)
    let answerHitTest = (): void => {}
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        await new Promise<void>((resolve) => {
          answerHitTest = resolve
        })
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)
    const revoked = new AbortController()

    const click = runInRemoteCliBrowserScope(
      WORKSPACE,
      () => bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18),
      revoked.signal
    )
    await vi.waitFor(() =>
      expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
    )
    revoked.abort()
    answerHitTest()

    await expect(click).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    expect(dispatchedMouseEvents(wc)).toHaveLength(0)
  })

  it('holds the page against a running helper click once the host is revoked', async () => {
    const helperCallbacks: ExecFileCallback[] = []
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('click')) {
          helperCallbacks.push(cb)
        } else {
          cb(null, JSON.stringify({ success: true, data: null }), '')
        }
        return createFakeAgentBrowserChild({ stdin: { on: vi.fn(), end: vi.fn() } })
      }
    )
    const revoked = new AbortController()

    const click = runInRemoteCliBrowserScope(
      WORKSPACE,
      () => bridge.click('@e1', undefined, 'tab-1'),
      revoked.signal
    )
    await vi.waitFor(() => expect(helperCallbacks).toHaveLength(1))
    expect(() => assertHelperStepAdmitted()).not.toThrow()

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every instance the hoisted mock constructs has a vi.fn stop.
    const proxy = CdpWsProxyMock.instances.at(-1) as { stop: ReturnType<typeof vi.fn> }
    let heldWhenRetired = false
    proxy.stop.mockImplementation(async () => {
      try {
        assertHelperStepAdmitted()
      } catch {
        heldWhenRetired = true
      }
    })
    revoked.abort()
    expect(() => assertHelperStepAdmitted()).toThrow('stopped sharing')
    await vi.waitFor(() => expect(proxy.stop).toHaveBeenCalled())
    helperCallbacks[0]!(
      null,
      JSON.stringify({ success: false, error: 'The Orca desktop stopped sharing its browser' }),
      ''
    )

    await expect(click).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    expect(() => assertHelperStepAdmitted()).not.toThrow()
    // Daemon retirement must precede releasing the page's admission hold.
    expect(heldWhenRetired).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.arrayContaining(['close']),
      expect.anything(),
      expect.anything()
    )
  })

  it('still runs a desktop-local command queued behind a host command that was revoked', async () => {
    const wc = mockWebContents(100)
    let answerHitTest = (): void => {}
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        await new Promise<void>((resolve) => {
          answerHitTest = resolve
        })
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)
    const revoked = new AbortController()
    const hostClick = runInRemoteCliBrowserScope(
      WORKSPACE,
      () => bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18),
      revoked.signal
    )
    hostClick.catch(() => {})
    await vi.waitFor(() =>
      expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
    )

    const localMove = bridge.mouseMove(5, 6, undefined, 'tab-1')
    revoked.abort()
    answerHitTest()

    await expect(hostClick).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    await expect(localMove).resolves.toBeDefined()
    expect(dispatchedMouseEvents(wc)).toEqual([
      ['Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved', x: 5, y: 6 })]
    ])
  })

  it('never hit-tests (which can activate the element) once revoked during the focus wait', async () => {
    let grantFocus = (): void => {}
    const release = vi.fn()
    const guardUserFocusForAgentInput = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          grantFocus = () => resolve(release)
        })
    )
    bridge = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { guardUserFocusForAgentInput })
    )
    bridge.setActiveTab(100)
    const wc = mockWebContents(100)
    wc.getType.mockReturnValue('webview')
    wc.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockReturnValue(wc)
    const revoked = new AbortController()

    const click = runInRemoteCliBrowserScope(
      WORKSPACE,
      () => bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18),
      revoked.signal
    )
    await vi.waitFor(() => expect(guardUserFocusForAgentInput).toHaveBeenCalled())
    revoked.abort()
    grantFocus()

    await expect(click).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
    expect(dispatchedMouseEvents(wc)).toHaveLength(0)
    expect(release).toHaveBeenCalled()
  })

  it('lets go off the page of a press that landed just before the host was revoked', async () => {
    const wc = mockWebContents(100)
    const revoked = new AbortController()
    wc.debugger.sendCommand.mockImplementation(async (method: string, params?: unknown) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      if (
        typeof params === 'object' &&
        params !== null &&
        'type' in params &&
        params.type === 'mousePressed'
      ) {
        revoked.abort()
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)

    const click = runInRemoteCliBrowserScope(
      WORKSPACE,
      () => bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18),
      revoked.signal
    )

    await expect(click).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    expect(dispatchedMouseEvents(wc)).toEqual([
      ['Input.dispatchMouseEvent', expect.objectContaining({ type: 'mousePressed', x: 10 })],
      ['Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseReleased', x: -1, y: -1 })]
    ])
  })

  describe('a press a finished host command left held', () => {
    function hostCommand<T>(
      host: AbortController,
      run: () => Promise<T>,
      cancel?: AbortSignal
    ): Promise<T> {
      const signal = cancel ? AbortSignal.any([host.signal, cancel]) : host.signal
      return runInRemoteCliBrowserScope(WORKSPACE, run, signal, undefined, host.signal)
    }

    function mouseTypes(wc: ReturnType<typeof mockWebContents>): unknown[] {
      return dispatchedMouseEvents(wc)
        .map((call) =>
          typeof call === 'object' && call !== null && 1 in call ? call[1] : undefined
        )
        .map((params) =>
          typeof params === 'object' && params !== null && 'type' in params
            ? params.type
            : undefined
        )
        .filter((type) => type !== 'mouseMoved')
    }

    it('is let go of off the page when the host is revoked between commands', async () => {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockReturnValue(wc)
      const host = new AbortController()

      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))
      expect(mouseTypes(wc)).toEqual(['mousePressed'])

      host.abort()

      await vi.waitFor(() => expect(mouseTypes(wc)).toEqual(['mousePressed', 'mouseReleased']))
      expect(dispatchedMouseEvents(wc)[1]).toEqual([
        'Input.dispatchMouseEvent',
        expect.objectContaining({ type: 'mouseReleased', x: -1, y: -1, button: 'left' })
      ])
    })

    it('is not let go of again once a later command of that host released it', async () => {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockReturnValue(wc)
      const host = new AbortController()

      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))
      await hostCommand(host, () => bridge.mouseUp('left', undefined, 'tab-1'))
      host.abort()
      await Promise.resolve()

      expect(mouseTypes(wc)).toEqual(['mousePressed', 'mouseReleased'])
    })

    it("survives a later command's own cancel, and goes when the host does", async () => {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockReturnValue(wc)
      const host = new AbortController()
      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))
      const cancel = new AbortController()
      cancel.abort()

      await expect(
        hostCommand(host, () => bridge.mouseMove(30, 40, undefined, 'tab-1'), cancel.signal)
      ).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
      expect(mouseTypes(wc)).toEqual(['mousePressed'])

      host.abort()
      await vi.waitFor(() => expect(mouseTypes(wc)).toEqual(['mousePressed', 'mouseReleased']))
    })

    it("is no longer the host's once the desktop presses that button itself", async () => {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockReturnValue(wc)
      const host = new AbortController()
      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))
      await bridge.mouseUp('left', undefined, 'tab-1')
      await bridge.mouseDown('left', undefined, 'tab-1')

      host.abort()
      await Promise.resolve()

      expect(mouseTypes(wc)).toEqual(['mousePressed', 'mouseReleased', 'mousePressed'])
    })

    it("lets go in the page's turn, before a desktop press queued after the host ended", async () => {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockReturnValue(wc)
      const host = new AbortController()
      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))

      host.abort()
      await bridge.mouseDown('left', undefined, 'tab-1')

      expect(mouseTypes(wc)).toEqual(['mousePressed', 'mouseReleased', 'mousePressed'])
      expect(dispatchedMouseEvents(wc)[2]).toEqual([
        'Input.dispatchMouseEvent',
        expect.objectContaining({ type: 'mousePressed', buttons: 1 })
      ])
    })

    it("is another host's once that host presses it, and stays down when the first ends", async () => {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockReturnValue(wc)
      const first = new AbortController()
      const second = new AbortController()
      await hostCommand(first, () => bridge.mouseDown('left', undefined, 'tab-1'))
      await hostCommand(second, () => bridge.mouseDown('left', undefined, 'tab-1'))

      first.abort()
      await bridge.mouseMove(1, 2, undefined, 'tab-1')
      expect(mouseTypes(wc)).toEqual(['mousePressed', 'mousePressed'])

      second.abort()
      await vi.waitFor(() => expect(mouseTypes(wc)).toHaveLength(3))
    })

    it('lets go exactly once when the attachment ends during the command that pressed', async () => {
      const wc = mockWebContents(100)
      const host = new AbortController()
      wc.debugger.sendCommand.mockImplementation(async (_method: string, params?: unknown) => {
        if (typeof params === 'object' && params !== null && 'type' in params) {
          if (params.type === 'mousePressed') {
            host.abort()
          }
        }
        return {}
      })
      webContentsFromIdMock.mockReturnValue(wc)

      // The press landed before revocation, so the command succeeds.
      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))
      await bridge.mouseMove(1, 2, undefined, 'tab-1')

      expect(mouseTypes(wc)).toEqual(['mousePressed', 'mouseReleased'])
    })

    it("stays the host's when the desktop's own press of it fails", async () => {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockReturnValue(wc)
      const host = new AbortController()
      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))
      wc.debugger.sendCommand.mockRejectedValueOnce(new Error('page busy'))
      await expect(bridge.mouseDown('left', undefined, 'tab-1')).rejects.toThrow()

      host.abort()

      await vi.waitFor(() =>
        expect(mouseTypes(wc)).toEqual(['mousePressed', 'mousePressed', 'mouseReleased'])
      )
    })

    it('keeps reporting a button the desktop still holds when it lets go of the host one', async () => {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockReturnValue(wc)
      const host = new AbortController()
      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))
      await bridge.mouseDown('right', undefined, 'tab-1')

      host.abort()

      await vi.waitFor(() => expect(mouseTypes(wc)).toHaveLength(3))
      expect(dispatchedMouseEvents(wc)[2]).toEqual([
        'Input.dispatchMouseEvent',
        expect.objectContaining({ type: 'mouseReleased', button: 'left', buttons: 2 })
      ])
    })

    it('lets go, when the host ends, of a press a later command of it made again', async () => {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockResolvedValue({})
      webContentsFromIdMock.mockReturnValue(wc)
      const host = new AbortController()
      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))
      await hostCommand(host, () => bridge.mouseUp('left', undefined, 'tab-1'))
      await hostCommand(host, () => bridge.mouseDown('left', undefined, 'tab-1'))

      host.abort()

      await vi.waitFor(() =>
        expect(mouseTypes(wc)).toEqual([
          'mousePressed',
          'mouseReleased',
          'mousePressed',
          'mouseReleased'
        ])
      )
    })
  })

  it("starts the page's CDP proxy outside the host's scope, so it outlives that host's request", async () => {
    let startedInHostScope: boolean | undefined
    CdpWsProxyMock.mockImplementationOnce(function (this: Record<string, unknown>) {
      this.start = vi.fn(async () => {
        startedInHostScope = captureRemoteCliBrowserScope().bridged
        return 'ws://127.0.0.1:9222'
      })
      this.stop = vi.fn(async () => {})
      this.getPort = vi.fn(() => 9222)
      CdpWsProxyMock.instances.push(this)
    })
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return createFakeAgentBrowserChild({ stdin: { on: vi.fn(), end: vi.fn() } })
      }
    )

    await runInRemoteCliBrowserScope(WORKSPACE, () => bridge.click('@e1', undefined, 'tab-1'))

    expect(startedInHostScope).toBe(false)
  })
})
