import type * as BrowserErrorTypes from '../browser-error'
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
vi.mock('electron', () => {
  return {
    app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
    webContents: { fromId: webContentsFromIdMock }
  }
})
const { CdpWsProxyMock, proxyStops } = vi.hoisted(() => {
  const instances: unknown[] = []
  const proxyStops: ReturnType<typeof vi.fn>[] = []
  const MockClass = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    _wc: unknown
  ) {
    this._wc = _wc
    const endpoint = `ws://127.0.0.1:9222/token-${instances.length}`
    this.start = vi.fn(async () => endpoint)
    const stop = vi.fn(async () => {})
    this.stop = stop
    proxyStops.push(stop)
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }), proxyStops }
})

vi.mock('../cdp/transport/cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))
vi.mock('../browser-error', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

vi.mock('../cdp/commands/cdp-bridge', async () => {
  const { BrowserError } = await vi.importMock<typeof BrowserErrorTypes>('../browser-error')
  return { BrowserError }
})

import { AgentBrowserBridge } from './agent-browser-bridge'
import {
  answerAgentBrowserCommands,
  mockBrowserManager,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  succeedRecordingAgentBrowserSpawns
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

// agent-browser only reaches Orca's proxy through AGENT_BROWSER_CDP; `--cdp <port>` drops the token path.
describe('AgentBrowserBridge CDP endpoint contract', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    proxyStops.length = 0
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('passes the tokened endpoint only through env, for batch and raw CLI spawns', async () => {
    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {
      snapshot: ''
    })

    await bridge.snapshot()
    await bridge.exec('--cdp 4444 get title')

    // The stale-session reset only closes a daemon; it must not name any CDP target.
    const [reset, ...commands] = spawns
    expect(reset).toMatchObject({ command: ['close'], cdp: undefined })
    expect(commands.map(({ command }) => command[0])).toEqual(['snapshot', 'get'])
    for (const spawn of commands) {
      expect(spawn.cdp).toBe('ws://127.0.0.1:9222/token-0')
      expect(spawn.args).not.toContain('--cdp')
      expect(spawn.args.join(' ')).not.toContain('token-0')
    }
  })

  it('resets the session and explains a proxy refusal so the next command reconnects', async () => {
    let refuse = true
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb, _args, _child, opts) => {
      if (command[0] === 'close') {
        cb(null, JSON.stringify({ success: true, data: null }), '')
      } else if (refuse) {
        cb(
          Object.assign(new Error('exit 1'), { code: 1 }),
          JSON.stringify({
            success: false,
            error: 'CDP WebSocket connect failed: HTTP error: 404 Not Found'
          }),
          ''
        )
      } else {
        cb(null, JSON.stringify({ success: true, data: { cdp: opts.env?.AGENT_BROWSER_CDP } }), '')
      }
    })

    await expect(bridge.snapshot()).rejects.toMatchObject({
      code: 'browser_error',
      message: expect.stringMatching(/refused by Orca's browser proxy.*404.*retry the command/)
    })
    await vi.waitFor(() => expect(proxyStops[0]).toHaveBeenCalled())

    refuse = false
    await expect(bridge.snapshot()).resolves.toMatchObject({})
    expect(CdpWsProxyMock.instances).toHaveLength(2)
    const lastSpawnEnv = execFileMock.mock.calls.at(-1)?.[2]?.env
    expect(lastSpawnEnv?.AGENT_BROWSER_CDP).toBe('ws://127.0.0.1:9222/token-1')
  })
})
