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
import { runInRemoteCliBrowserScope } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  createFakeAgentBrowserChild,
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

  it('clears reload fallback timer after the load event settles', async () => {
    vi.useFakeTimers()
    try {
      succeedWith(null)
      const wc = {
        ...mockWebContents(100, 'https://reloaded.example', 'Reloaded'),
        reload: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn()
      }
      webContentsFromIdMock.mockReturnValue(wc)

      const result = bridge.reload()

      await vi.waitFor(() => {
        expect(wc.on).toHaveBeenCalledWith('did-finish-load', expect.any(Function))
      })

      const finishListener = wc.on.mock.calls.find(
        ([event]) => event === 'did-finish-load'
      )?.[1] as (() => void) | undefined
      const failListener = wc.on.mock.calls.find(([event]) => event === 'did-fail-load')?.[1] as
        | (() => void)
        | undefined
      expect(finishListener).toBeDefined()
      expect(failListener).toBeDefined()
      expect(vi.getTimerCount()).toBe(1)

      finishListener!()

      await expect(result).resolves.toEqual({
        url: 'https://reloaded.example',
        title: 'Reloaded'
      })
      expect(wc.removeListener).toHaveBeenCalledWith('did-finish-load', finishListener)
      expect(wc.removeListener).toHaveBeenCalledWith('did-fail-load', failListener)
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(10_000)
      expect(wc.removeListener).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('navigates the registered webContents without spawning agent-browser', async () => {
    const wc = mockWebContents(100, 'https://example.com/start', 'Example')
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('https://example.com/next')).resolves.toEqual({
      url: 'https://example.com/next',
      title: 'Example'
    })

    expect(wc.loadURL).toHaveBeenCalledWith('https://example.com/next')
    expect(wc.isLoading).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('preserves scheme-less navigation semantics at the direct WebContents boundary', async () => {
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('example.com')).resolves.toEqual({
      url: 'https://example.com/',
      title: 'Example'
    })
    expect(wc.loadURL).toHaveBeenCalledWith('https://example.com/')
  })

  it('rejects unsupported direct navigation URLs without falling back to agent-browser', async () => {
    const wc = mockWebContents(100)
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('javascript:alert(1)')).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'Unsupported browser URL: javascript:alert(1)'
    })
    expect(wc.loadURL).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails closed and releases the command queue when direct navigation never settles', async () => {
    vi.useFakeTimers()
    try {
      const wc = mockWebContents(100)
      wc.loadURL.mockReturnValue(new Promise<void>(() => {}))
      webContentsFromIdMock.mockReturnValue(wc)

      const navigation = bridge.goto('https://example.com/hangs')
      const rejection = expect(navigation).rejects.toMatchObject({
        code: 'browser_error',
        message: 'Failed to navigate browser page tab-1: Browser navigation timed out after 30000ms'
      })
      await vi.advanceTimersByTimeAsync(30_000)

      await rejection
      expect(execFileMock).not.toHaveBeenCalled()
      expect(
        (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
      ).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for a superseding navigation to land after direct navigation aborts', async () => {
    const wc = mockWebContents(100, 'https://example.com/current', 'Example')
    let currentUrl = 'https://example.com/current'
    let loading = true
    const listeners = new Map<string, () => void>()
    wc.getURL = () => currentUrl
    wc.isLoading.mockImplementation(() => loading)
    wc.on.mockImplementation((event: string, listener: () => void) => {
      listeners.set(event, listener)
    })
    wc.loadURL.mockRejectedValue(
      Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
    )
    webContentsFromIdMock.mockReturnValue(wc)

    const navigation = bridge.goto('https://example.com/sso')
    await vi.waitFor(() => expect(listeners.get('did-stop-loading')).toBeDefined())

    currentUrl = 'https://example.com/login'
    loading = false
    listeners.get('did-stop-loading')!()

    await expect(navigation).resolves.toEqual({
      url: 'https://example.com/login',
      title: 'Example'
    })
    expect(wc.removeListener).toHaveBeenCalledWith(
      'did-stop-loading',
      listeners.get('did-stop-loading')
    )
    expect(wc.removeListener).toHaveBeenCalledWith('destroyed', listeners.get('destroyed'))
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('resolves with the unchanged page when a download-triggered load aborts', async () => {
    const wc = mockWebContents(100, 'https://example.com/current', 'Example')
    wc.loadURL.mockRejectedValue(Object.assign(new Error('ERR_ABORTED (-3)'), { errno: -3 }))
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('https://example.com/download')).resolves.toEqual({
      url: 'https://example.com/current',
      title: 'Example'
    })
    expect(wc.isLoading).toHaveBeenCalledTimes(1)
    expect(wc.on).not.toHaveBeenCalledWith('did-stop-loading', expect.any(Function))
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails closed when the page prevents direct navigation', async () => {
    const wc = mockWebContents(100, 'https://example.com/unsaved', 'Unsaved changes')
    wc.loadURL.mockImplementation(async () => {
      const preventUnload = wc.on.mock.calls.find(
        ([event]) => event === 'will-prevent-unload'
      )?.[1] as ((event: { defaultPrevented: boolean }) => void) | undefined
      preventUnload!({ defaultPrevented: false })
      throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('https://example.com/next')).rejects.toMatchObject({
      code: 'browser_error',
      message: 'Failed to navigate browser page tab-1: ERR_ABORTED (-3)'
    })
    const preventUnload = wc.on.mock.calls.find(([event]) => event === 'will-prevent-unload')?.[1]
    expect(wc.removeListener).toHaveBeenCalledWith('will-prevent-unload', preventUnload)
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails closed when the navigation superseding an abort fails', async () => {
    const wc = mockWebContents(100, 'https://example.com/current', 'Example')
    wc.loadURL.mockRejectedValue(
      Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
    )
    webContentsFromIdMock.mockReturnValue(wc)
    const getBrowserPageLoadError = vi.fn(() => ({
      code: -105,
      description: 'Name not resolved',
      validatedUrl: 'https://nxdomain.example/'
    }))
    const b = new AgentBrowserBridge(
      mockBrowserManager(new Map([['tab-1', 100]]), undefined, {
        getBrowserPageLoadError
      })
    )
    b.setActiveTab(100)

    await expect(b.goto('https://example.com/redirect')).rejects.toMatchObject({
      code: 'browser_error',
      message: 'Failed to navigate browser page tab-1: Name not resolved (-105)'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('bounds and cleans up a superseding navigation that never settles', async () => {
    vi.useFakeTimers()
    try {
      const wc = mockWebContents(100, 'https://example.com/current', 'Example')
      wc.isLoading.mockReturnValue(true)
      wc.loadURL.mockRejectedValue(
        Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
      )
      webContentsFromIdMock.mockReturnValue(wc)

      const navigation = bridge.goto('https://example.com/redirect')
      const rejection = expect(navigation).rejects.toMatchObject({
        code: 'browser_error',
        message: 'Failed to navigate browser page tab-1: Browser navigation timed out after 30000ms'
      })
      await vi.advanceTimersByTimeAsync(30_000)

      await rejection
      const stopLoading = wc.on.mock.calls.find(([event]) => event === 'did-stop-loading')?.[1]
      const destroyed = wc.on.mock.calls.find(([event]) => event === 'destroyed')?.[1]
      expect(wc.removeListener).toHaveBeenCalledWith('did-stop-loading', stopLoading)
      expect(wc.removeListener).toHaveBeenCalledWith('destroyed', destroyed)
      expect(vi.getTimerCount()).toBe(0)
      expect(
        (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
      ).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans up when the guest is destroyed while attaching the replacement wait', async () => {
    vi.useFakeTimers()
    try {
      const wc = mockWebContents(100, 'https://example.com/current', 'Example')
      let destroyed = false
      wc.isDestroyed = () => destroyed
      wc.isLoading.mockReturnValueOnce(true).mockImplementationOnce(() => {
        destroyed = true
        throw new Error('Object has been destroyed')
      })
      wc.loadURL.mockRejectedValue(
        Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 })
      )
      webContentsFromIdMock.mockReturnValue(wc)

      await expect(bridge.goto('https://example.com/redirect')).rejects.toMatchObject({
        code: 'browser_tab_not_found',
        message: 'Browser page tab-1 is no longer available'
      })

      const stopLoading = wc.on.mock.calls.find(([event]) => event === 'did-stop-loading')?.[1]
      const destroyedListener = wc.on.mock.calls.find(([event]) => event === 'destroyed')?.[1]
      expect(wc.removeListener).toHaveBeenCalledWith('did-stop-loading', stopLoading)
      expect(wc.removeListener).toHaveBeenCalledWith('destroyed', destroyedListener)
      expect(vi.getTimerCount()).toBe(0)
      expect(
        (bridge as unknown as { commandQueues: Map<string, unknown[]> }).commandQueues.size
      ).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails closed when direct navigation fails for a non-abort reason', async () => {
    const wc = mockWebContents(100, 'https://example.com/current', 'Example')
    wc.loadURL.mockRejectedValue(
      Object.assign(new Error('ERR_NAME_NOT_RESOLVED (-105)'), {
        code: 'ERR_NAME_NOT_RESOLVED',
        errno: -105
      })
    )
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.goto('https://nxdomain.example')).rejects.toMatchObject({
      code: 'browser_error',
      message: 'Failed to navigate browser page tab-1: ERR_NAME_NOT_RESOLVED (-105)'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each([
    {
      command: 'goto',
      run: (b: AgentBrowserBridge) => b.goto('https://embedded.example/next'),
      helperArg: 'goto',
      directMethod: 'loadURL'
    },
    {
      command: 'evaluate',
      run: (b: AgentBrowserBridge) => b.evaluate('document.title'),
      helperArg: 'eval',
      directMethod: 'Runtime.evaluate'
    }
  ])(
    'does not route $command to another browser when the helper session is stale',
    async ({ run, helperArg, directMethod }) => {
      const wc = mockWebContents(100, 'https://embedded.example/current', 'Embedded')
      wc.debugger.sendCommand.mockImplementation(async (_method: string, params?: unknown) => ({
        result: {
          value:
            (params as { expression?: string } | undefined)?.expression === 'location.origin'
              ? 'https://embedded.example'
              : 'Embedded'
        }
      }))
      webContentsFromIdMock.mockReturnValue(wc)
      const wrongOwnerCalls: string[][] = []
      let helperSessionIsStale = false

      execFileMock.mockImplementation(
        (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
          if (args.includes('close')) {
            cb(null, JSON.stringify({ success: true, data: null }), '')
          } else if (args.includes('snapshot')) {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'ready' } }), '')
          } else {
            if (helperSessionIsStale && !args.includes('--cdp')) {
              wrongOwnerCalls.push(args)
            }
            cb(
              null,
              JSON.stringify({
                success: true,
                data: { url: 'https://external.example', title: 'External', result: 'external' }
              }),
              ''
            )
          }
          return createFakeAgentBrowserChild({ kill: vi.fn() })
        }
      )

      await bridge.snapshot()
      helperSessionIsStale = true
      await run(bridge)

      expect(wrongOwnerCalls).toEqual([])
      expect(
        execFileMock.mock.calls.some((call) => (call[1] as string[]).includes(helperArg))
      ).toBe(false)
      if (directMethod === 'loadURL') {
        expect(wc.loadURL).toHaveBeenCalledWith('https://embedded.example/next')
      } else {
        expect(wc.debugger.sendCommand).toHaveBeenCalledWith(
          'Runtime.evaluate',
          expect.objectContaining({ expression: 'document.title' })
        )
      }
    }
  )

  it('returns direct evaluation value and full page URL semantics without spawning agent-browser', async () => {
    const wc = mockWebContents(100, 'https://example.com/path?query=1')
    wc.debugger.sendCommand.mockResolvedValue({ result: { value: 42 } })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.evaluate('6 * 7')).resolves.toEqual({
      result: '42',
      origin: 'https://example.com/path?query=1'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each([
    [{ answer: 42 }, '{"answer":42}'],
    [['a', 'b'], '["a","b"]']
  ])('preserves structured direct evaluation values as JSON text', async (value, expected) => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockResolvedValue({ result: { value } })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.evaluate('structuredValue')).resolves.toMatchObject({ result: expected })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('surfaces direct evaluation exceptions without falling back to agent-browser', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockResolvedValue({
      result: { type: 'object' },
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'ReferenceError: missingValue is not defined' }
      }
    })
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.evaluate('missingValue')).rejects.toMatchObject({
      code: 'browser_eval_error',
      message: 'ReferenceError: missingValue is not defined'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('fails closed when the registered webContents debugger is stale', async () => {
    const wc = mockWebContents(100)
    wc.debugger.sendCommand.mockRejectedValue(new Error('Debugger is detached'))
    webContentsFromIdMock.mockReturnValue(wc)

    await expect(bridge.evaluate('document.title')).rejects.toMatchObject({
      code: 'browser_error',
      message: 'Failed to evaluate in browser page tab-1: Debugger is detached'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each([
    ['goto', (b: AgentBrowserBridge) => b.goto('https://example.com/next', undefined, 'tab-1')],
    ['evaluate', (b: AgentBrowserBridge) => b.evaluate('document.title', undefined, 'tab-1')]
  ])('fails closed when direct %s targets a destroyed webContents', async (_command, run) => {
    const wc = mockWebContents(100)
    wc.isDestroyed = () => true
    webContentsFromIdMock.mockReturnValue(wc)
    const unregisterGuest = vi.fn()
    const b = new AgentBrowserBridge(
      mockBrowserManager(new Map([['tab-1', 100]]), new Map(), { unregisterGuest })
    )
    b.setActiveTab(100)

    await expect(run(b)).rejects.toMatchObject({
      code: 'browser_tab_not_found',
      message: 'Browser page tab-1 is no longer available'
    })
    expect(unregisterGuest).toHaveBeenCalledWith('tab-1')
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('returns navigation state from a replacement registered during load', async () => {
    const tabs = new Map([['tab-1', 100]])
    const oldWc = mockWebContents(100, 'https://example.com/start', 'Old')
    const replacementWc = mockWebContents(200, 'https://example.com/final', 'Replacement')
    oldWc.loadURL.mockImplementation(async () => {
      tabs.set('tab-1', 200)
    })
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 ? oldWc : id === 200 ? replacementWc : null
    )
    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(100)

    await expect(b.goto('https://example.com/next')).resolves.toEqual({
      url: 'https://example.com/final',
      title: 'Replacement'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each([false, true].flatMap((primed) => [false, true].map((close) => ({ primed, close }))))(
    'retargets own goto through a real swap notification; daemon=$primed/close=$close',
    async ({ primed, close }) => {
      const tabs = new Map([['tab-1', 100]])
      const old = mockWebContents(100, 'https://example.com/start', 'Old')
      const replacement = mockWebContents(200, 'https://example.com/final', 'Replacement')
      const entered = Promise.withResolvers<void>()
      const loaded = Promise.withResolvers<void>()
      old.loadURL.mockImplementation(() => {
        entered.resolve()
        return loaded.promise
      })
      webContentsFromIdMock.mockImplementation((id) =>
        id === 100 ? old : id === 200 ? replacement : null
      )
      const b = new AgentBrowserBridge(mockBrowserManager(tabs))
      b.setActiveTab(100)
      succeedWith({ snapshot: 'ready' })
      if (primed) {
        await b.snapshot()
      }
      const navigation = b.goto('https://example.com/next', undefined, 'tab-1')
      await entered.promise
      const queued = b.snapshot(undefined, 'tab-1')
      const settled = Promise.allSettled([navigation, queued])
      tabs.set('tab-1', 200)
      await b.onProcessSwap('tab-1', 200, 100)
      if (close) {
        await b.onTabClosed(200)
        tabs.delete('tab-1')
      }
      loaded.resolve()
      const results = await settled
      if (close) {
        expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected'])
      } else {
        expect(results[0]).toEqual({
          status: 'fulfilled',
          value: {
            url: 'https://example.com/final',
            title: 'Replacement'
          }
        })
        expect(results[1]).toMatchObject({
          status: 'rejected',
          reason: { code: 'browser_tab_closed' }
        })
        await expect(b.snapshot(undefined, 'tab-1')).resolves.toMatchObject({
          browserPageId: 'tab-1'
        })
      }
      await b.destroyAllSessions()
    }
  )

  it('routes direct commands to the replacement registration, not the stale session owner', async () => {
    const tabs = new Map([['tab-1', 100]])
    const oldWc = mockWebContents(100, 'https://old.example', 'Old')
    const replacementWc = mockWebContents(200, 'https://new.example', 'New')
    replacementWc.debugger.sendCommand.mockImplementation(
      async (_method: string, params?: unknown) => ({
        result: {
          value:
            (params as { expression?: string } | undefined)?.expression === 'location.origin'
              ? 'https://new.example'
              : 'New'
        }
      })
    )
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 ? oldWc : id === 200 ? replacementWc : null
    )
    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(100)

    succeedWith({ snapshot: 'ready' })
    await b.snapshot()
    tabs.set('tab-1', 200)
    await b.onProcessSwap('tab-1', 200, 100)
    execFileMock.mockClear()

    await expect(b.evaluate('document.title', undefined, 'tab-1')).resolves.toEqual({
      result: 'New',
      origin: 'https://new.example'
    })
    expect(replacementWc.debugger.sendCommand).toHaveBeenCalledWith(
      'Runtime.evaluate',
      expect.objectContaining({ expression: 'document.title' })
    )
    expect(oldWc.debugger.sendCommand).not.toHaveBeenCalled()
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it.each(['close', 'shutdown', 'second-swap'] as const)(
    'revokes during pending old daemon teardown: %s',
    async (event) => {
      const tabs = new Map([['tab-1', 100]])
      const old = mockWebContents(100)
      const replacement = mockWebContents(200)
      const final = mockWebContents(300)
      const entered = Promise.withResolvers<void>()
      const loaded = Promise.withResolvers<void>()
      const closingDaemon = Promise.withResolvers<void>()
      let finishClose: (() => void) | undefined
      old.loadURL.mockImplementation(() => {
        entered.resolve()
        return loaded.promise
      })
      webContentsFromIdMock.mockImplementation((id) =>
        id === 100 ? old : id === 200 ? replacement : id === 300 ? final : null
      )
      const b = new AgentBrowserBridge(mockBrowserManager(tabs))
      b.setActiveTab(100)
      succeedWith({ snapshot: 'ready' })
      await b.snapshot()
      let heldClose = false
      execFileMock.mockImplementation(
        (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
          if (args.includes('close') && !heldClose) {
            heldClose = true
            finishClose = () => cb(null, JSON.stringify({ success: true, data: null }), '')
            closingDaemon.resolve()
          } else {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'ready' } }), '')
          }
          return createFakeAgentBrowserChild({ kill: vi.fn() })
        }
      )
      const navigation = b.goto('https://example.com/next', undefined, 'tab-1')
      await entered.promise
      const queued = b.snapshot(undefined, 'tab-1')
      const settled = Promise.allSettled([navigation, queued])
      tabs.set('tab-1', 200)
      const swapping = b.onProcessSwap('tab-1', 200, 100)
      await closingDaemon.promise
      let closing: Promise<void>
      let waiting: Promise<unknown> | undefined
      if (event === 'second-swap') {
        loaded.resolve()
        await expect(navigation).resolves.toBeDefined()
        waiting = b.snapshot(undefined, 'tab-1')
        const waitingResult = Promise.allSettled([waiting])
        tabs.set('tab-1', 300)
        closing = b.onProcessSwap('tab-1', 300, 200)
        finishClose?.()
        await Promise.all([swapping, closing])
        expect((await waitingResult)[0]?.status).toBe('rejected')
        expect(CdpWsProxyMock.instances).toHaveLength(1)
        await expect(b.snapshot(undefined, 'tab-1')).resolves.toMatchObject({
          browserPageId: 'tab-1'
        })
      } else {
        closing = event === 'shutdown' ? b.destroyAllSessions() : b.onTabClosed(200)
        if (event === 'close') {
          tabs.delete('tab-1')
        }
        loaded.resolve()
        expect((await settled).map((result) => result.status)).toEqual(['rejected', 'rejected'])
      }
      finishClose?.()
      await Promise.all([swapping, closing])
      await b.destroyAllSessions()
    }
  )

  it.each([false, true])(
    'rechecks the replacement SSH route before returning navigation: %s',
    async (routed) => {
      const tabs = new Map([['tab-1', 100]])
      const old = mockWebContents(100)
      const replacement = mockWebContents(200, 'https://replacement.test', 'Replacement')
      const b = new AgentBrowserBridge(mockBrowserManager(tabs))
      b.setActiveTab(100)
      webContentsFromIdMock.mockImplementation((id) =>
        id === 100 ? old : id === 200 ? replacement : null
      )
      old.loadURL.mockImplementation(async () => {
        tabs.set('tab-1', 200)
        await b.onProcessSwap('tab-1', 200, 100)
      })
      const title = vi.spyOn(replacement, 'getTitle')
      const navigation = runInRemoteCliBrowserScope(
        'worktree',
        () => b.goto('https://next.test', undefined, 'tab-1'),
        undefined,
        (id) => id === 100 || (routed && id === 200)
      )
      if (routed) {
        await expect(navigation).resolves.toEqual({
          url: 'https://replacement.test',
          title: 'Replacement'
        })
      } else {
        await expect(navigation).rejects.toMatchObject({ code: 'desktop_browser_bridge_unrouted' })
        expect(title).not.toHaveBeenCalled()
      }
      await b.destroyAllSessions()
    }
  )

  it('revokes a retained navigation before its batched shutdown cleanup slot is available', async () => {
    const tabs = new Map<string, number>([['tab-1', 100]])
    const guests = new Map([
      [100, mockWebContents(100)],
      [200, mockWebContents(200)]
    ])
    for (let index = 0; index < 4; index++) {
      tabs.set(`other-${index}`, 300 + index)
      guests.set(300 + index, mockWebContents(300 + index))
    }
    webContentsFromIdMock.mockImplementation((id) => guests.get(id) ?? null)
    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(100)
    succeedWith({ snapshot: 'ready' })
    for (let index = 0; index < 4; index++) {
      await b.snapshot(undefined, `other-${index}`)
    }
    await b.snapshot(undefined, 'tab-1')
    const entered = Promise.withResolvers<void>()
    const loaded = Promise.withResolvers<void>()
    const retiring = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    const releases: (() => void)[] = []
    let finishRetirement: (() => void) | undefined
    const old = guests.get(100)!
    old.loadURL.mockImplementation(() => {
      entered.resolve()
      return loaded.promise
    })
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        const finish = () => cb(null, JSON.stringify({ success: true, data: null }), '')
        if (args.includes('close') && args.includes('orca-tab-tab-1')) {
          finishRetirement = finish
          retiring.resolve()
        } else if (args.includes('close')) {
          releases.push(finish)
          if (releases.length === 4) {
            blocked.resolve()
          }
        } else {
          finish()
        }
        return createFakeAgentBrowserChild({ kill: vi.fn() })
      }
    )
    const navigation = b.goto('https://next.test', undefined, 'tab-1')
    const settled = Promise.allSettled([navigation])
    await entered.promise
    tabs.set('tab-1', 200)
    const swapping = b.onProcessSwap('tab-1', 200, 100)
    await retiring.promise
    const shutdown = b.destroyAllSessions()
    await blocked.promise
    loaded.resolve()
    const result = await settled
    finishRetirement?.()
    for (const release of releases) {
      release()
    }
    await Promise.all([swapping, shutdown])
    expect(releases).toHaveLength(4)
    expect(result[0]).toMatchObject({ status: 'rejected', reason: { code: 'browser_tab_closed' } })
  })
})
