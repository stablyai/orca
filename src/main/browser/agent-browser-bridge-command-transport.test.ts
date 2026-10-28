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
  answerAgentBrowserCommands,
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

  it('keeps CDP discovery failures generic while the tab session is still live', async () => {
    failWith(CDP_DISCOVERY_FAILURE)
    await expect(bridge.snapshot()).rejects.toMatchObject({
      code: 'browser_error',
      message: CDP_DISCOVERY_FAILURE
    })
  })

  it('maps in-flight CDP discovery failures to tab not found after the session disappears', async () => {
    let releaseSnapshot: (() => void) | null = null
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) => {
      if (command[0] === 'snapshot') {
        releaseSnapshot = () => {
          cb(null, JSON.stringify({ success: false, error: CDP_DISCOVERY_FAILURE }), '')
        }
        return
      }
      cb(null, JSON.stringify({ success: true, data: null }), '')
    })

    const snapshotPromise = bridge.snapshot()

    await vi.waitFor(() => {
      expect(releaseSnapshot).not.toBeNull()
    })
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

  it('strips --cdp and --session from exec commands', async () => {
    succeedWith({ output: 'ok' })
    await bridge.exec(
      'dblclick @e3 --cdp ws://evil --session hijack --cdp=ws://evil-equals --session=hijack-equals'
    )

    const execCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('dblclick')
    )
    const args = execCall![1] as string[]
    expect(args.join(' ')).not.toContain('ws://evil')
    expect(args.join(' ')).not.toContain('ws://evil-equals')
    expect(args.join(' ')).not.toContain('hijack')
    expect(args.join(' ')).not.toContain('hijack-equals')
    expect(args).toContain('dblclick')
    expect(args).toContain('@e3')
  })

  it('returns browser_timeout for timed conditional waits without recycling the session', async () => {
    const killedError = Object.assign(new Error('timeout'), { killed: true })
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) => {
      if (command[0] === 'wait') {
        cb(killedError, '', '')
        return
      }
      cb(null, JSON.stringify({ success: true, data: { snapshot: 'fresh' } }), '')
    })

    for (let i = 0; i < 3; i++) {
      await expect(bridge.wait({ selector: '.missing', timeout: 1200 })).rejects.toThrow(
        'Timed out waiting for browser condition after 1200ms.'
      )
    }

    await bridge.snapshot()

    expect(CdpWsProxyMock.instances).toHaveLength(1)
  })

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

  it('returns browser_error with truncated output for malformed JSON', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, 'Error: not json output', '')
      }
    )
    await expect(bridge.snapshot()).rejects.toThrow('Unexpected output from agent-browser')
  })
})
