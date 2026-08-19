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
  createSucceedWith,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

function failWith(error: string): void {
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, JSON.stringify({ success: false, error }), '')
    }
  )
}

const CDP_DISCOVERY_FAILURE =
  'Auto-launch failed: All CDP discovery methods failed: connect ECONNREFUSED 127.0.0.1:9222; WebSocket connect failed'

describe('AgentBrowserBridge', () => {
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

  // ── Session naming ──

  it('uses browserPageId as session name', async () => {
    succeedWith({ snapshot: '...' })
    await bridge.snapshot()

    const args = execFileMock.mock.calls[0][1] as string[]
    expect(args).toContain('--session')
    expect(args[args.indexOf('--session') + 1]).toBe('orca-tab-tab-1')
  })

  // ── Embedded CDP ownership ──

  it('passes --cdp on every helper command family so a restarted daemon cannot launch Chrome', async () => {
    succeedWith({ snapshot: '...' })
    await bridge.snapshot()

    // Why: calls[0] is stale-session 'close'; find the snapshot call
    const snapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(snapshotCall![1]).toContain('--cdp')
    const cdpIdx = (snapshotCall![1] as string[]).indexOf('--cdp')
    expect((snapshotCall![1] as string[])[cdpIdx + 1]).toBe('9222')

    await bridge.click('@e1')
    await bridge.mouseMove(10, 20)
    await bridge.setOffline('on')
    await bridge.consoleLog()
    await bridge.exec('get title')

    for (const command of ['click', 'mouse', 'set', 'console', 'get']) {
      const call = execFileMock.mock.calls.find((candidate: unknown[]) =>
        (candidate[1] as string[]).includes(command)
      )
      expect(call).toBeDefined()
      const args = call![1] as string[]
      expect(args).toContain('--cdp')
      expect(args[args.indexOf('--cdp') + 1]).toBe('9222')
    }
  })

  // ── --json always appended ──

  it('always appends --json to commands', async () => {
    succeedWith({ snapshot: '...' })
    await bridge.snapshot()

    const snapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect((snapshotCall![1] as string[]).at(-1)).toBe('--json')
  })

  // ── Output translation ──

  it('translates success response to result', async () => {
    succeedWith({ snapshot: 'tree output' })
    const result = await bridge.snapshot()
    expect(result).toEqual({ browserPageId: 'tab-1', snapshot: 'tree output' })
  })

  it('translates error response to BrowserError', async () => {
    failWith('Element not found')
    await expect(bridge.click('@e1')).rejects.toThrow('Element not found')
  })

  it('keeps CDP discovery failures generic while the tab session is still live', async () => {
    failWith(CDP_DISCOVERY_FAILURE)
    await expect(bridge.snapshot()).rejects.toMatchObject({
      code: 'browser_error',
      message: CDP_DISCOVERY_FAILURE
    })
  })

  it('maps in-flight CDP discovery failures to tab not found after the session disappears', async () => {
    let releaseSnapshot: (() => void) | null = null
    const activeChild = { kill: vi.fn() }
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('snapshot')) {
          releaseSnapshot = () => {
            cb(null, JSON.stringify({ success: false, error: CDP_DISCOVERY_FAILURE }), '')
          }
          return activeChild
        }
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return { kill: vi.fn() }
      }
    )

    const snapshotPromise = bridge.snapshot()

    await vi.waitFor(() => {
      expect(releaseSnapshot).not.toBeNull()
    })
    // Why: this reproduces the teardown race where the tab close path has
    // already removed the bridge session before agent-browser reports that
    // its CDP proxy disappeared.
    ;(bridge as unknown as { sessions: Map<string, unknown> }).sessions.delete('orca-tab-tab-1')
    releaseSnapshot!()

    await expect(snapshotPromise).rejects.toMatchObject({
      code: 'browser_tab_not_found',
      message: 'Browser page tab-1 is no longer available'
    })
  })

  it('maps target disappearance during session creation to tab not found', async () => {
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockImplementationOnce(() => wc).mockImplementationOnce(() => null)

    await expect(bridge.snapshot(undefined, 'tab-1')).rejects.toMatchObject({
      code: 'browser_tab_not_found',
      message: 'Browser page tab-1 is no longer available'
    })
  })

  it('handles malformed JSON from agent-browser', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, 'not json at all', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow()
  })

  // ── exec passthrough ──

  it('strips --cdp and --session from exec commands', async () => {
    succeedWith({ output: 'ok' })
    await bridge.exec(
      'dblclick @e3 --cdp ws://evil --session hijack --cdp=ws://evil-equals --session=hijack-equals'
    )

    // Why: find the actual exec call (contains 'dblclick'), not the stale-session close
    const execCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('dblclick')
    )
    const args = execCall![1] as string[]
    // The bridge's own --session and --cdp (for session init) are expected.
    // Verify the user-injected ones were stripped, including --flag=value forms.
    expect(args.join(' ')).not.toContain('ws://evil')
    expect(args.join(' ')).not.toContain('ws://evil-equals')
    expect(args.join(' ')).not.toContain('hijack')
    expect(args.join(' ')).not.toContain('hijack-equals')
    expect(args).toContain('dblclick')
    expect(args).toContain('@e3')
  })

  // ── Command queue serialization ──

  it('serializes concurrent commands per session', async () => {
    const commandCalls: string[][] = []

    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        commandCalls.push(args)
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const [r1, r2] = await Promise.all([bridge.snapshot(), bridge.click('@e1')])
    expect(r1).toEqual({ browserPageId: 'tab-1', ok: true })
    expect(r2).toEqual({ ok: true })
    // Why: close runs first (stale session cleanup), then commands execute sequentially
    const snapshotIdx = commandCalls.findIndex((a) => a.includes('snapshot'))
    const clickIdx = commandCalls.findIndex((a) => a.includes('click'))
    expect(snapshotIdx).toBeLessThan(clickIdx)
  })

  // ── Cookie command arg building ──

  it('builds cookie set args with all options', async () => {
    succeedWith({ success: true })
    await bridge.cookieSet({
      name: 'sid',
      value: 'abc',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      expires: 1700000000
    })

    const args = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(args).toContain('cookies')
    expect(args).toContain('set')
    expect(args).toContain('sid')
    expect(args).toContain('abc')
    expect(args).toContain('--domain')
    expect(args).toContain('.example.com')
    expect(args).toContain('--path')
    expect(args).toContain('/')
    expect(args).toContain('--secure')
    expect(args).toContain('--httpOnly')
    expect(args).toContain('--sameSite')
    expect(args).toContain('Lax')
    expect(args).toContain('--expires')
    expect(args).toContain('1700000000')
  })

  // ── Viewport command arg building ──

  it('applies viewport emulation through CDP so mobile mode is preserved', async () => {
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockReturnValue(wc)

    await bridge.setViewport(375, 812, 2, true)

    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true
    })
    expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setVisibleSize', {
      width: 375,
      height: 812
    })
    const viewportCall = execFileMock.mock.calls.find((call: unknown[]) =>
      (call[1] as string[]).includes('viewport')
    )
    expect(viewportCall).toBeUndefined()
  })

  it('normalizes selector wait state=visible to the default supported semantics', async () => {
    succeedWith({ selector: 'h1', waited: 'selector' })

    await bridge.wait({ selector: 'h1', state: 'visible' })

    const args = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(args).toContain('wait')
    expect(args).toContain('h1')
    expect(args).not.toContain('--state')
  })

  it('enforces conditional wait timeouts at the bridge layer', async () => {
    succeedWith({ selector: '#ready', waited: 'selector' })

    await bridge.wait({ selector: '#ready', timeout: 1200 })

    const args = execFileMock.mock.calls.at(-1)![1] as string[]
    const options = execFileMock.mock.calls.at(-1)![2] as { timeout?: number; env?: unknown }
    expect(args).toContain('wait')
    expect(args).toContain('#ready')
    expect(options.timeout).toBe(2200)
    expect(options.env).toBe(process.env)
  })

  it('returns browser_timeout for timed conditional waits without recycling the session', async () => {
    const killedError = Object.assign(new Error('timeout'), { killed: true })
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('wait')) {
          cb(killedError, '', '')
          return
        }
        cb(null, JSON.stringify({ success: true, data: { snapshot: 'fresh' } }), '')
      }
    )

    for (let i = 0; i < 3; i++) {
      await expect(bridge.wait({ selector: '.missing', timeout: 1200 })).rejects.toThrow(
        'Timed out waiting for browser condition after 1200ms.'
      )
    }

    await bridge.snapshot()

    expect(CdpWsProxyMock.instances).toHaveLength(1)
  })

  // ── Stderr passthrough on non-timeout errors ──

  it('passes stderr through as error message on execFile failure', async () => {
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        cb(new Error('exit code 1'), '', 'daemon crashed: segfault')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('daemon crashed: segfault')
  })

  it('falls back to error.message when stderr is empty', async () => {
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        cb(new Error('Command failed'), '', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('Command failed')
  })

  // ── Malformed JSON returns BrowserError ──

  it('returns browser_error with truncated output for malformed JSON', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, 'Error: not json output', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('Unexpected output from agent-browser')
  })
})
