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

  it('acquires an automation visibility lease while running snapshot commands', async () => {
    const lifecycleEvents: string[] = []
    const restore = vi.fn(() => {
      lifecycleEvents.push('restore-100')
    })
    const acquireAutomationVisibility = vi.fn(async (webContentsId: number) => {
      lifecycleEvents.push(`acquire-${webContentsId}`)
      return restore
    })

    const b = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, {
        acquireAutomationVisibility
      })
    )
    b.setActiveTab(100)

    let releaseSnapshot: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        if (args.includes('snapshot')) {
          lifecycleEvents.push('command-snapshot')
          releaseSnapshot = () => {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'tree' } }), '')
          }
          return
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const snapshot = b.snapshot()

    await vi.waitFor(() => {
      expect(releaseSnapshot).not.toBeNull()
    })
    expect(lifecycleEvents).toEqual(['acquire-100', 'command-snapshot'])
    expect(restore).not.toHaveBeenCalled()

    releaseSnapshot!()

    await expect(snapshot).resolves.toEqual({ browserPageId: 'tab-1', snapshot: 'tree' })
    expect(lifecycleEvents).toEqual(['acquire-100', 'command-snapshot', 'restore-100'])
  })

  it('re-resolves the page after automation visibility re-registers the webview', async () => {
    const tabs = new Map([['tab-1', 100]])
    const wc100 = mockWebContents(100)
    const wc200 = mockWebContents(200, 'https://example.com/reloaded', 'Reloaded')
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === 100) {
        return wc100
      }
      if (id === 200) {
        return wc200
      }
      return null
    })

    const acquireAutomationVisibility = vi.fn(async () => {
      tabs.set('tab-1', 200)
      return vi.fn()
    })
    const b = new AgentBrowserBridge(
      mockBrowserManager(tabs, undefined, {
        acquireAutomationVisibility
      })
    )
    b.setActiveTab(100)

    succeedWith({ snapshot: 'tree' })
    await expect(b.snapshot()).resolves.toEqual({ browserPageId: 'tab-1', snapshot: 'tree' })

    expect(acquireAutomationVisibility).toHaveBeenCalledWith(100)
    const createdProxyIds = CdpWsProxyMock.instances.map(
      (instance) => (instance as { _wc?: { id?: number } })._wc?.id
    )
    expect(createdProxyIds).toEqual([100, 200])
  })

  it('preserves intercept routes when automation visibility re-registers the webview', async () => {
    const tabs = new Map([['tab-1', 100]])
    const wc100 = mockWebContents(100)
    const wc200 = mockWebContents(200, 'https://example.com/reloaded', 'Reloaded')
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === 100) {
        return wc100
      }
      if (id === 200) {
        return wc200
      }
      return null
    })

    let reregisterOnVisibility = false
    const acquireAutomationVisibility = vi.fn(async () => {
      if (reregisterOnVisibility) {
        tabs.set('tab-1', 200)
      }
      return vi.fn()
    })
    const b = new AgentBrowserBridge(
      mockBrowserManager(tabs, undefined, {
        acquireAutomationVisibility
      })
    )
    b.setActiveTab(100)

    const commandCalls: string[][] = []
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        commandCalls.push(args)
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    await b.interceptEnable(['https://old.example/**'])
    reregisterOnVisibility = true
    await expect(b.snapshot()).resolves.toEqual({ browserPageId: 'tab-1', ok: true })

    const routeCalls = commandCalls.filter(
      (args) => args.includes('network') && args.includes('route')
    )
    expect(routeCalls).toHaveLength(2)
    expect(routeCalls.at(-1)).toContain('https://old.example/**')
    expect(routeCalls.at(-1)).toContain('--cdp')
    expect(routeCalls.at(-1)).toContain('9222')
  })

  it('clears stale sessions after direct CDP visibility re-registration', async () => {
    const tabs = new Map([['tab-1', 100]])
    const wc100 = mockWebContents(100)
    const wc200 = mockWebContents(200, 'https://example.com/reloaded', 'Reloaded')
    wc200.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === 100) {
        return wc100
      }
      if (id === 200) {
        return wc200
      }
      return null
    })

    let reregisterOnVisibility = false
    const acquireAutomationVisibility = vi.fn(async () => {
      if (reregisterOnVisibility) {
        tabs.set('tab-1', 200)
      }
      return vi.fn()
    })
    const b = new AgentBrowserBridge(
      mockBrowserManager(tabs, undefined, {
        acquireAutomationVisibility
      })
    )
    b.setActiveTab(100)

    succeedWith({ snapshot: 'before' })
    await b.snapshot()

    reregisterOnVisibility = true
    await expect(b.mouseClick(10, 20, 'right', undefined, 'tab-1')).resolves.toEqual({
      clicked: { x: 10, y: 20, button: 'right', adjusted: false, handled: false }
    })

    succeedWith({ snapshot: 'after' })
    await expect(b.snapshot()).resolves.toEqual({ browserPageId: 'tab-1', snapshot: 'after' })

    const createdProxyIds = CdpWsProxyMock.instances.map(
      (instance) => (instance as { _wc?: { id?: number } })._wc?.id
    )
    expect(createdProxyIds).toEqual([100, 200])
  })

  it('serializes screenshot visibility prep across sessions', async () => {
    vi.useFakeTimers()
    try {
      const tabs = new Map([
        ['tab-1', 1],
        ['tab-2', 2]
      ])
      const worktrees = new Map([
        ['tab-1', 'wt-1'],
        ['tab-2', 'wt-2']
      ])
      const lifecycleEvents: string[] = []
      const acquireAutomationVisibilityMock = vi.fn(async (webContentsId: number) => {
        lifecycleEvents.push(`acquire-${webContentsId}`)
        return () => {
          lifecycleEvents.push(`restore-${webContentsId}`)
        }
      })
      const wc1 = mockWebContents(1)
      const wc2 = mockWebContents(2)
      webContentsFromIdMock.mockImplementation((id: number) =>
        id === 1 ? wc1 : id === 2 ? wc2 : null
      )
      existsSyncMock.mockReturnValue(true)
      const screenshotBytes = Buffer.from('serialized-screenshot')
      readFileSyncMock.mockReturnValue(screenshotBytes)

      const b = new AgentBrowserBridge(
        mockBrowserManager(tabs, worktrees, {
          acquireAutomationVisibility: acquireAutomationVisibilityMock
        })
      )
      b.setActiveTab(1, 'wt-1')
      b.setActiveTab(2, 'wt-2')

      let releaseFirstScreenshot: (() => void) | null = null
      execFileMock.mockImplementation(
        (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
          if (args.includes('close')) {
            cb(null, JSON.stringify({ success: true, data: null }), '')
            return
          }
          if (args.includes('screenshot')) {
            const sessionName = args[args.indexOf('--session') + 1]
            lifecycleEvents.push(`command-${sessionName}`)
            if (sessionName === 'orca-tab-tab-1' && !releaseFirstScreenshot) {
              releaseFirstScreenshot = () => {
                cb(null, JSON.stringify({ success: true, data: { path: '/tmp/tab-1.png' } }), '')
              }
              return
            }
            cb(
              null,
              JSON.stringify({ success: true, data: { path: `/tmp/${sessionName}.png` } }),
              ''
            )
            return
          }
          cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
        }
      )

      const first = b.screenshot('png', 'wt-1')
      const second = b.screenshot('png', 'wt-2')

      await Promise.resolve()
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(300)

      expect(lifecycleEvents).toContain('acquire-1')
      expect(lifecycleEvents).toContain('command-orca-tab-tab-1')
      expect(lifecycleEvents).not.toContain('acquire-2')

      expect(releaseFirstScreenshot).not.toBeNull()
      releaseFirstScreenshot!()
      await expect(first).resolves.toEqual({
        data: screenshotBytes.toString('base64'),
        format: 'png'
      })

      await Promise.resolve()
      await Promise.resolve()

      expect(lifecycleEvents.indexOf('restore-1')).toBeLessThan(
        lifecycleEvents.indexOf('acquire-2')
      )

      await vi.advanceTimersByTimeAsync(300)
      await expect(second).resolves.toEqual({
        data: screenshotBytes.toString('base64'),
        format: 'png'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('captures full-page screenshots directly through CDP using CSS layout bounds', async () => {
    vi.useFakeTimers()
    try {
      const wc = mockWebContents(100)
      wc.debugger.sendCommand.mockImplementation((method: string) => {
        if (method === 'Page.getLayoutMetrics') {
          return Promise.resolve({
            cssContentSize: { width: 600.2, height: 900.4 },
            contentSize: { width: 1200.4, height: 1800.8 }
          })
        }
        if (method === 'Page.captureScreenshot') {
          return Promise.resolve({ data: 'full-cdp-shot' })
        }
        return Promise.resolve({})
      })
      webContentsFromIdMock.mockReturnValue(wc)

      execFileMock.mockImplementation(
        (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
          cb(null, JSON.stringify({ success: true, data: null }), '')
        }
      )

      const screenshotPromise = bridge.fullPageScreenshot('png')
      await vi.advanceTimersByTimeAsync(500)

      await expect(screenshotPromise).resolves.toEqual({
        data: 'full-cdp-shot',
        format: 'png'
      })

      expect(wc.debugger.sendCommand).toHaveBeenNthCalledWith(1, 'Page.getLayoutMetrics', {})
      expect(wc.debugger.sendCommand).toHaveBeenNthCalledWith(2, 'Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: 601, height: 901, scale: 1 }
      })
      const screenshotCall = execFileMock.mock.calls.find((call: unknown[]) =>
        (call[1] as string[]).includes('screenshot')
      )
      expect(screenshotCall).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
