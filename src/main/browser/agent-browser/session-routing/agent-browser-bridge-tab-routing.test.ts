import type * as BrowserErrorTypes from '../../browser-error'
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

vi.mock('../../cdp/transport/cdp-ws-proxy', () => ({
  CdpWsProxy: CdpWsProxyMock
}))
vi.mock('../../browser-error', () => ({
  BrowserError: class BrowserError extends Error {
    code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

vi.mock('../../cdp/commands/cdp-bridge', async () => {
  const { BrowserError } = await vi.importMock<typeof BrowserErrorTypes>('../../browser-error')
  return { BrowserError }
})

import { AgentBrowserBridge } from '../agent-browser-bridge'
import {
  getActiveRpcAgentSessionId,
  runWithActiveRpcCaller
} from '../../../runtime/rpc/rpc-active-caller'
import {
  answerAgentBrowserCommands,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks
} from '../testing/agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

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

  it('rejects an unpinned ref from another tab snapshot until the current tab is snapshotted', async () => {
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const worktrees = new Map([
      ['tab-a', 'wt-1'],
      ['tab-b', 'wt-1']
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))
    const b = new AgentBrowserBridge(mockBrowserManager(tabs, worktrees))
    b.setActiveTab(1, 'wt-1')
    const clickSessions: string[] = []
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb, args) => {
      if (command[0] === 'click') {
        clickSessions.push(args[args.indexOf('--session') + 1])
      }
      const data = command[0] === 'snapshot' ? { snapshot: '' } : {}
      cb(null, JSON.stringify({ success: true, data }), '')
    })

    await b.snapshot('wt-1')
    await b.tabSwitch(undefined, 'wt-1', 'tab-b')

    await expect(b.click('@e2', 'wt-1')).rejects.toMatchObject({
      code: 'browser_stale_ref',
      message: expect.stringContaining(
        'Run snapshot to get refs for page tab-b, or pass --page tab-a'
      )
    })
    await expect(b.exec('click e2', 'wt-1')).rejects.toMatchObject({ code: 'browser_stale_ref' })
    await b.exec('keyboard type e2', 'wt-1')
    expect(clickSessions).toEqual([])

    await b.click('@e2', undefined, 'tab-a')
    await b.exec('snapshot -i', 'wt-1')
    await b.click('@e2', 'wt-1')
    expect(clickSessions).toEqual(['orca-tab-tab-a', 'orca-tab-tab-b'])
  })

  it("marks a tab switch queued behind another chat's command as the switching chat's", async () => {
    const chatA = '11111111-1111-4111-8111-111111111111'
    const chatB = '22222222-2222-4222-8222-222222222222'
    const tabs = new Map([
      ['tab-a', 1],
      ['tab-b', 2]
    ])
    const worktrees = new Map([
      ['tab-a', 'wt-1'],
      ['tab-b', 'wt-1']
    ])
    const wc1 = mockWebContents(1)
    const wc2 = mockWebContents(2)
    webContentsFromIdMock.mockImplementation((id: number) => (id === 1 ? wc1 : wc2))
    const marks: [string, string | undefined][] = []
    const b = new AgentBrowserBridge(
      mockBrowserManager(tabs, worktrees, {
        beginAgentCommand: (pageId: string) => {
          marks.push([pageId, getActiveRpcAgentSessionId()])
          return { agent: true, run: (execute) => execute(), end: () => {} }
        }
      })
    )
    b.setActiveTab(1, 'wt-1')
    const held: { releaseA?: () => void } = {}
    answerAgentBrowserCommands(execFileMock, stdinWrites, (_command, cb) => {
      const answer = (): void =>
        cb(null, JSON.stringify({ success: true, data: { snapshot: '' } }), '')
      if (held.releaseA) {
        answer()
      } else {
        held.releaseA = answer
      }
    })
    const inChat = <T>(chat: string, run: () => T): T =>
      runWithActiveRpcCaller({ kind: 'local-cli' }, run, chat)

    const snapshot = inChat(chatA, () => b.snapshot('wt-1'))
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalled())
    const tabSwitch = inChat(chatB, () => b.tabSwitch(undefined, 'wt-1', 'tab-b'))
    held.releaseA?.()
    await Promise.all([snapshot, tabSwitch])

    expect(marks).toContainEqual(['tab-b', chatB])
    expect(marks).not.toContainEqual(['tab-b', chatA])
  })
})
