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

  it('fails closed when stale agent-browser session ownership cannot be reset', async () => {
    vi.useFakeTimers()
    try {
      const closeKill = vi.fn()
      execFileMock.mockImplementation(
        (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
          if (args.includes('close')) {
            return { kill: closeKill }
          }
          if (args.includes('snapshot')) {
            cb(null, JSON.stringify({ success: true, data: { snapshot: 'ready' } }), '')
            return { kill: vi.fn() }
          }
          throw new Error(`unexpected agent-browser args ${args.join(' ')}`)
        }
      )

      const promise = bridge.snapshot()
      const rejection = expect(promise).rejects.toMatchObject({
        code: 'browser_owner_unavailable',
        message:
          'Could not reset stale helper session orca-tab-tab-1; retry after agent-browser exits'
      })

      await vi.advanceTimersByTimeAsync(3_000)

      await rejection
      expect(closeKill).toHaveBeenCalled()
      expect(execFileMock.mock.calls.some((call) => call[1].includes('snapshot'))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Timeout escalation ──

  it('destroys session after 3 consecutive timeouts', async () => {
    const killedError = Object.assign(new Error('timeout'), { killed: true })

    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        cb(killedError, '', '')
      }
    )

    for (let i = 0; i < 3; i++) {
      await expect(bridge.snapshot()).rejects.toThrow('timed out')
    }

    // Session is destroyed — next command should re-create it (new --cdp flag)
    succeedWith({ snapshot: 'fresh' })
    await bridge.snapshot()

    const lastArgs = execFileMock.mock.calls.at(-1)![1] as string[]
    expect(lastArgs).toContain('--cdp')
  })

  it('waits for pending session destruction before recreating the same session', async () => {
    succeedWith({ snapshot: 'initial' })
    await bridge.snapshot()

    execFileMock.mockClear()

    const commandCalls: string[][] = []
    let releaseDestroyClose: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        commandCalls.push(args)
        if (args.includes('close')) {
          if (!releaseDestroyClose) {
            releaseDestroyClose = () => {
              cb(null, JSON.stringify({ success: true, data: null }), '')
            }
            return
          }
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return
        }
        if (args.includes('snapshot')) {
          cb(null, JSON.stringify({ success: true, data: { snapshot: 'after-destroy' } }), '')
          return
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    const destroyPromise = (
      bridge as unknown as { destroySession: (name: string) => Promise<void> }
    ).destroySession('orca-tab-tab-1')
    const nextSnapshot = bridge.snapshot()

    await Promise.resolve()
    await Promise.resolve()

    expect(commandCalls.filter((args) => args.includes('close'))).toHaveLength(1)
    expect(commandCalls.some((args) => args.includes('snapshot'))).toBe(false)
    expect(releaseDestroyClose).not.toBeNull()

    releaseDestroyClose!()
    await destroyPromise
    await expect(nextSnapshot).resolves.toEqual({
      browserPageId: 'tab-1',
      snapshot: 'after-destroy'
    })
    expect(commandCalls.filter((args) => args.includes('close'))).toHaveLength(2)
  })

  it('tears down a session that finishes creating after destruction starts', async () => {
    const commandCalls: string[][] = []
    let releaseStaleClose: (() => void) | null = null
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        commandCalls.push(args)
        if (args.includes('close') && !releaseStaleClose) {
          releaseStaleClose = () => {
            cb(null, JSON.stringify({ success: true, data: null }), '')
          }
          return { kill: vi.fn() }
        }
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return { kill: vi.fn() }
      }
    )

    const ensurePromise = (
      bridge as unknown as {
        ensureSession: (
          sessionName: string,
          browserPageId: string,
          webContentsId: number
        ) => Promise<void>
      }
    ).ensureSession('orca-tab-tab-1', 'tab-1', 100)

    await vi.waitFor(() => {
      expect(releaseStaleClose).not.toBeNull()
    })
    expect(CdpWsProxyMock.instances).toHaveLength(0)

    const destroyPromise = (
      bridge as unknown as { destroySession: (name: string) => Promise<void> }
    ).destroySession('orca-tab-tab-1')

    releaseStaleClose!()
    await ensurePromise
    await destroyPromise

    const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions
    const proxy = CdpWsProxyMock.instances[0] as { stop: ReturnType<typeof vi.fn> }
    expect(commandCalls.filter((args) => args.includes('close'))).toHaveLength(2)
    expect(sessions.size).toBe(0)
    expect(proxy.stop).toHaveBeenCalledTimes(1)
  })

  it('cancels the command already running when a session is destroyed', async () => {
    succeedWith({ snapshot: 'initial' })
    await bridge.snapshot()

    execFileMock.mockClear()

    const killedError = Object.assign(new Error('killed'), { killed: true })
    let resolveRunningCommand: (() => void) | null = null
    const activeChild = {
      kill: vi.fn(() => {
        resolveRunningCommand?.()
      })
    }

    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('snapshot')) {
          resolveRunningCommand = () => cb(killedError, '', '')
          return activeChild
        }
        if (args.includes('close')) {
          cb(null, JSON.stringify({ success: true, data: null }), '')
          return { kill: vi.fn() }
        }
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
        return { kill: vi.fn() }
      }
    )

    const runningSnapshot = bridge.snapshot()
    await vi.waitFor(() => {
      expect(resolveRunningCommand).not.toBeNull()
    })

    const destroyPromise = (
      bridge as unknown as { destroySession: (name: string) => Promise<void> }
    ).destroySession('orca-tab-tab-1')

    expect(activeChild.kill).toHaveBeenCalledTimes(1)
    await expect(runningSnapshot).rejects.toMatchObject({
      code: 'browser_tab_closed',
      message: 'Tab was closed while command was running'
    })
    await destroyPromise
  })

  // ── Process swap ──

  it('destroys session on process swap and re-inits with --cdp', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    succeedWith({ snapshot: 'tree' })
    await b.snapshot()

    // Why: calls[0] is the stale-session 'close'; find the snapshot call with --cdp
    const firstSnapshotCall = execFileMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(firstSnapshotCall![1]).toContain('--cdp')

    // Simulate process swap: update tab mapping + notify bridge
    tabs.set('tab-1', 200)
    const newWc = mockWebContents(200)
    webContentsFromIdMock.mockReturnValue(newWc)
    succeedWith(null) // for the 'close' command in destroySession
    await b.onProcessSwap('tab-1', 200)

    // Next command should re-init with --cdp since session was destroyed
    succeedWith({ snapshot: 'new tree' })
    await b.snapshot()

    const snapshotCalls = execFileMock.mock.calls.filter((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    expect(snapshotCalls.length).toBeGreaterThanOrEqual(2)
    const lastSnapshotArgs = snapshotCalls.at(-1)![1] as string[]
    // After process swap + session destroy, the new session must re-init with --cdp
    expect(lastSnapshotArgs).toContain('--cdp')
  })

  it('does not replay stale intercept routes after process swap when the first command disables routing', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    succeedWith({ ok: true })
    await b.interceptEnable(['https://old.example/**'])

    tabs.set('tab-1', 200)
    webContentsFromIdMock.mockReturnValue(mockWebContents(200))
    succeedWith(null)
    await b.onProcessSwap('tab-1', 200)

    const commandCalls: string[][] = []
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        commandCalls.push(args)
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    await b.interceptDisable()

    const routeCalls = commandCalls.filter(
      (args) => args.includes('network') && args.includes('route')
    )
    expect(routeCalls).toHaveLength(0)

    const unrouteCall = commandCalls.find(
      (args) => args.includes('network') && args.includes('unroute')
    )
    expect(unrouteCall).toBeDefined()
    expect(unrouteCall).toContain('--cdp')
  })

  it('does not replay stale intercept routes after process swap when the first command enables a new route', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    succeedWith({ ok: true })
    await b.interceptEnable(['https://old.example/**'])

    tabs.set('tab-1', 200)
    webContentsFromIdMock.mockReturnValue(mockWebContents(200))
    succeedWith(null)
    await b.onProcessSwap('tab-1', 200)

    const commandCalls: string[][] = []
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        commandCalls.push(args)
        cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
      }
    )

    await b.interceptEnable(['https://new.example/**'])

    const routeCalls = commandCalls.filter(
      (args) => args.includes('network') && args.includes('route')
    )
    expect(routeCalls).toHaveLength(1)
    expect(routeCalls[0]).toContain('https://new.example/**')
    expect(routeCalls[0]).not.toContain('https://old.example/**')
    expect(routeCalls[0]).toContain('--cdp')
  })

  it('clears pending intercept restore state when a swapped tab closes before reuse', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    succeedWith({ ok: true })
    await b.interceptEnable(['https://old.example/**'])

    tabs.set('tab-1', 200)
    webContentsFromIdMock.mockReturnValue(mockWebContents(200))
    succeedWith(null)
    await b.onProcessSwap('tab-1', 200)

    expect(
      (b as unknown as { pendingInterceptRestore: Map<string, string[]> }).pendingInterceptRestore
        .size
    ).toBe(1)

    await b.onTabClosed(200)

    expect(
      (b as unknown as { pendingInterceptRestore: Map<string, string[]> }).pendingInterceptRestore
        .size
    ).toBe(0)
  })

  // ── destroyAllSessions ──

  it('destroys all active sessions', async () => {
    succeedWith({ snapshot: 'tree' })
    await bridge.snapshot()

    // Should have one session now
    succeedWith(null) // for the 'close' call
    await bridge.destroyAllSessions()

    // Next command should re-create session with --cdp
    succeedWith({ snapshot: 'fresh' })
    await bridge.snapshot()

    const snapshotCalls = execFileMock.mock.calls.filter((c: unknown[]) =>
      (c[1] as string[]).includes('snapshot')
    )
    const lastSnapshotArgs = snapshotCalls.at(-1)![1] as string[]
    expect(lastSnapshotArgs).toContain('--cdp')
  })
})
