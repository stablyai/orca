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
vi.mock('../../cdp/transport/cdp-ws-proxy', () => ({ CdpWsProxy: CdpWsProxyMock }))

import { AgentBrowserBridge } from '../agent-browser-bridge'
import { runInRemoteCliBrowserScope } from '../../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from '../testing/agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const WORKSPACE = 'repo-host::/srv/app'

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
  })
})
