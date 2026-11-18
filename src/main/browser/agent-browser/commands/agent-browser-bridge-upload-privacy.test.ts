import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CdpElementCapture } from '../../cdp/commands/cdp-element-capture'
import { AgentBrowserBridge } from '../agent-browser-bridge'
import {
  answerAgentBrowserCommands,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from '../testing/agent-browser-bridge-test-harness'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  fromId: vi.fn(),
  exists: vi.fn(() => false),
  read: vi.fn(() => Buffer.from('')),
  stdin: new Array<string>(),
  proxies: new Array<{ elementCapture: CdpElementCapture }>()
}))
vi.mock('child_process', () => ({ execFile: mocks.exec }))
vi.mock('fs', () => ({
  existsSync: mocks.exists,
  readFileSync: mocks.read,
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))
vi.mock('os', async (original) => ({
  ...(await original<typeof Os>()),
  platform: () => 'darwin',
  arch: () => 'arm64'
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/app', getAppPath: () => '/project', isPackaged: false },
  webContents: { fromId: mocks.fromId }
}))
vi.mock('../../cdp/transport/cdp-ws-proxy', () => ({
  CdpWsProxy: class {
    readonly elementCapture = new CdpElementCapture()
    constructor() {
      mocks.proxies.push(this)
    }
    async start() {
      return 'ws://127.0.0.1:9222'
    }
    async stop() {}
    getPort() {
      return 9222
    }
    pointAtNextNode() {}
  }
}))
overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, mocks.fromId)
let directory = ''
let file = ''
beforeEach(async () => {
  resetAgentBrowserBridgeMocks({
    webContentsFromIdMock: mocks.fromId,
    existsSyncMock: mocks.exists,
    readFileSyncMock: mocks.read,
    stdinWrites: mocks.stdin,
    cdpWsProxyInstances: mocks.proxies
  })
  directory = await mkdtemp(join(tmpdir(), 'orca-private-upload-'))
  file = join(directory, 'upload.txt')
  await writeFile(file, 'synthetic upload')
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it.each([
  ['https://kagi.com/search?q=one&token=upload-secret', 'https://kagi.com/search?q=one'],
  ['https://example.com/frame?token=ordinary', 'https://example.com/frame?token=ordinary']
])(
  'keeps the uploaded frame receipt safe without changing native file selection: %s',
  async (raw, safe) => {
    const guest = mockWebContents(100, 'https://example.com/top')
    guest.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Runtime.callFunctionOn') {
        const declaration =
          typeof params === 'object' && params !== null && 'functionDeclaration' in params
            ? params.functionDeclaration
            : ''
        return {
          result: {
            value:
              typeof declaration === 'string' && declaration.includes('ownerDocument.URL')
                ? raw
                : true
          }
        }
      }
      return {}
    })
    mocks.fromId.mockReturnValue(guest)
    answerAgentBrowserCommands(mocks.exec, mocks.stdin, (_command, cb) => {
      mocks.proxies
        .at(-1)
        ?.elementCapture.observe(
          'Runtime.callFunctionOn',
          { objectId: 'upload-input' },
          'iframe-session'
        )
      cb(null, JSON.stringify({ success: true, data: {} }), '')
    })
    const bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
    expect(await bridge.upload('#file', [file])).toMatchObject({ uploaded: 1, frameUrl: safe })
    expect(guest.debugger.sendCommand).toHaveBeenCalledWith(
      'DOM.setFileInputFiles',
      { files: [file], objectId: 'upload-input' },
      'iframe-session'
    )
  }
)

it.each(['url', 'title', 'text'])(
  'redacts explicit %s metadata without altering page text',
  async (what) => {
    mocks.fromId.mockReturnValue(mockWebContents(100, 'https://example.com/'))
    answerAgentBrowserCommands(mocks.exec, mocks.stdin, (_command, cb) => {
      cb(
        null,
        JSON.stringify({
          success: true,
          data: { [what]: 'https://kagi.com/search?token=get-secret&q=one' }
        }),
        ''
      )
    })
    const bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
    expect(await bridge.get(what)).toEqual({
      [what]:
        what === 'text'
          ? 'https://kagi.com/search?token=get-secret&q=one'
          : 'https://kagi.com/search?q=one'
    })
  }
)
