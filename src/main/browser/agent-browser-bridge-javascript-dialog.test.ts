import { EventEmitter } from 'node:events'
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
  const MockClass = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})
vi.mock('./cdp-ws-proxy', () => ({ CdpWsProxy: CdpWsProxyMock }))

import { AgentBrowserBridge } from './agent-browser-bridge'
import { installBrowserJavaScriptDialogs } from './browser-javascript-dialogs'
import { runInRemoteCliBrowserScope } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  createFakeAgentBrowserChild,
  createSucceedWith,
  mockBrowserManager,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

describe('agent commands while a page has a JavaScript dialog', () => {
  let bridge: AgentBrowserBridge
  let guest: Electron.WebContents & EventEmitter

  const openDialog = (dialogType: string, messageText: string) => {
    const callback = vi.fn()
    guest.emit('-run-dialog', { dialogType, messageText, defaultPromptText: 'def' }, callback)
    return callback
  }

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog owner only reads id, URL and its events.
    guest = Object.assign(new EventEmitter(), {
      id: 100,
      debugger: new EventEmitter(),
      isDestroyed: () => false,
      getURL: () => 'https://example.com'
    }) as unknown as Electron.WebContents & EventEmitter
    installBrowserJavaScriptDialogs(guest, () => null)
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('fails fast with the dialog text until the agent answers it', async () => {
    const callback = openDialog('prompt', 'Your name?')
    succeedWith({ snapshot: 'tree' })

    await expect(bridge.snapshot()).rejects.toThrow(
      'A JavaScript prompt is open on this page: "Your name?"'
    )
    expect(execFileMock).not.toHaveBeenCalled()

    await bridge.dialogAccept()
    expect(callback).toHaveBeenCalledExactlyOnceWith(true, 'def')
    await expect(bridge.snapshot()).resolves.toBeDefined()
  })

  it('answers a command that opens a dialog at once, without letting later commands overtake it', async () => {
    const batches: string[] = []
    let finishClick = (): void => {}
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        const child = createFakeAgentBrowserChild({
          stdin: { on: vi.fn(), end: (text: string) => batches.push(text) }
        })
        if (args.includes('batch') && batches.length === 0) {
          // The page is blocked, so agent-browser answers only once the dialog closes.
          queueMicrotask(() => openDialog('confirm', 'Delete everything?'))
          finishClick = () => cb(null, JSON.stringify({ success: true, data: {} }), '')
        } else {
          cb(null, JSON.stringify({ success: true, data: { snapshot: 'tree' } }), '')
        }
        return child
      }
    )

    const click = bridge.click('@e3')
    const queuedBehind = bridge.snapshot()

    await expect(click).rejects.toThrow(
      'The page opened a JavaScript confirm: "Delete everything?". The command may already have taken effect'
    )
    await expect(queuedBehind).rejects.toThrow('The command did not run.')
    await expect(bridge.snapshot()).rejects.toThrow('A JavaScript confirm is open on this page')

    await bridge.dialogDismiss()
    const snapshot = bridge.snapshot()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(batches).toHaveLength(1)

    finishClick()
    await expect(snapshot).resolves.toBeDefined()
    expect(batches).toHaveLength(2)
  })

  it('keeps a dialog on a page an SSH host may not drive out of that host’s errors', async () => {
    openDialog('alert', 'Desktop-only secret')

    const snapshot = runInRemoteCliBrowserScope(
      'workspace',
      () => bridge.snapshot(),
      undefined,
      () => false
    )

    await expect(snapshot).rejects.toThrow('This page is not browsing through the SSH host')
  })
})
