import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  execFileMock,
  webContentsFromIdMock,
  existsSyncMock,
  readFileSyncMock,
  lstatSyncMock,
  stdinWrites
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  existsSyncMock: vi.fn(() => false),
  readFileSyncMock: vi.fn(() => Buffer.from('')),
  lstatSyncMock: vi.fn(),
  stdinWrites: [] as string[]
}))

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  lstatSync: lstatSyncMock,
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
  createFakeAgentBrowserChild,
  createSucceedWith,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  succeedRecordingAgentBrowserSpawns,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const succeedWith = createSucceedWith(execFileMock, stdinWrites)

function isNetworkCommand(command: string[], verb: 'route' | 'unroute'): boolean {
  return command[0] === 'network' && command[1] === verb
}

function closeCallCount(): number {
  return execFileMock.mock.calls.filter((call: unknown[]) =>
    (call[1] as string[]).includes('close')
  ).length
}

describe('AgentBrowserBridge', () => {
  let bridge: AgentBrowserBridge

  // The fs mock cannot create an owned socket directory; opt in explicitly.
  function ownSocketDirectory(): void {
    Object.assign(bridge, {
      ownsAgentBrowserSocketDirectory: true,
      agentBrowserEnv: { AGENT_BROWSER_SOCKET_DIR: '/tmp/orca-ab-test' }
    })
  }

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    lstatSyncMock.mockReset()
    lstatSyncMock.mockReturnValue({})
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('snapshots a fresh owned session without launching a helper just to close it', async () => {
    ownSocketDirectory()
    lstatSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('No socket'), { code: 'ENOENT' })
    })
    webContentsFromIdMock.mockReturnValue(mockWebContents(100))
    succeedWith({ snapshot: 'ready' })

    expect(await bridge.snapshot()).toMatchObject({ snapshot: 'ready' })
    expect(closeCallCount()).toBe(0)
    expect(lstatSyncMock).toHaveBeenCalledWith('/tmp/orca-ab-test/orca-tab-tab-1.sock')
  })

  it('fails closed when stale agent-browser session ownership cannot be reset', async () => {
    ownSocketDirectory()
    lstatSyncMock.mockReturnValue({})
    vi.useFakeTimers()
    try {
      const closeKill = vi.fn()
      const commands: string[][] = []
      answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb, _args, child) => {
        commands.push(command)
        if (command.includes('close')) {
          child.kill.mockImplementation(closeKill)
          return
        }
        cb(null, JSON.stringify({ success: true, data: { snapshot: 'ready' } }), '')
      })

      const promise = bridge.snapshot()
      const rejection = expect(promise).rejects.toMatchObject({
        code: 'browser_owner_unavailable',
        message:
          'Could not reset stale helper session orca-tab-tab-1; retry after agent-browser exits'
      })

      await vi.advanceTimersByTimeAsync(3_000)

      await rejection
      expect(closeKill).toHaveBeenCalled()
      expect(commands.some((command) => command[0] === 'snapshot')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for pending session destruction before recreating the same session', async () => {
    succeedWith({ snapshot: 'initial' })
    await bridge.snapshot()

    execFileMock.mockClear()

    const commandCalls: string[][] = []
    let releaseDestroyClose: (() => void) | null = null
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) => {
      commandCalls.push(command)
      if (command.includes('close')) {
        if (!releaseDestroyClose) {
          releaseDestroyClose = () => {
            cb(null, JSON.stringify({ success: true, data: null }), '')
          }
          return
        }
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return
      }
      if (command[0] === 'snapshot') {
        cb(null, JSON.stringify({ success: true, data: { snapshot: 'after-destroy' } }), '')
        return
      }
      cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
    })

    const destroyPromise = (
      bridge as unknown as { destroySession: (name: string) => Promise<void> }
    ).destroySession('orca-tab-tab-1')
    const nextSnapshot = bridge.snapshot()

    await Promise.resolve()
    await Promise.resolve()

    expect(commandCalls.filter((command) => command.includes('close'))).toHaveLength(1)
    expect(commandCalls.some((command) => command[0] === 'snapshot')).toBe(false)
    expect(releaseDestroyClose).not.toBeNull()

    releaseDestroyClose!()
    await destroyPromise
    await expect(nextSnapshot).resolves.toEqual({
      browserPageId: 'tab-1',
      snapshot: 'after-destroy'
    })
    expect(commandCalls.filter((command) => command.includes('close'))).toHaveLength(2)
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
          return createFakeAgentBrowserChild({ kill: vi.fn() })
        }
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return createFakeAgentBrowserChild({ kill: vi.fn() })
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
    const releasePaint = vi.fn()
    bridge = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { holdGuestActive: () => releasePaint })
    )
    bridge.setActiveTab(100)
    succeedWith({ snapshot: 'initial' })
    await bridge.snapshot()
    releasePaint.mockClear()

    execFileMock.mockClear()

    const killedError = Object.assign(new Error('killed'), { killed: true })
    let activeChild: { kill: ReturnType<typeof vi.fn> } | null = null

    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb, _args, child) => {
      if (command[0] === 'snapshot') {
        child.kill.mockImplementation(() => cb(killedError, '', ''))
        activeChild = child
        return
      }
      if (command.includes('close')) {
        cb(null, JSON.stringify({ success: true, data: null }), '')
        return
      }
      cb(null, JSON.stringify({ success: true, data: { ok: true } }), '')
    })

    const runningSnapshot = bridge.snapshot()
    await vi.waitFor(() => {
      expect(activeChild).not.toBeNull()
    })

    const destroyPromise = (
      bridge as unknown as { destroySession: (name: string) => Promise<void> }
    ).destroySession('orca-tab-tab-1')

    expect(activeChild!.kill).toHaveBeenCalledTimes(1)
    await expect(runningSnapshot).rejects.toMatchObject({
      code: 'browser_tab_closed',
      message: 'Tab was closed while command was running'
    })
    await destroyPromise
    expect(releasePaint).toHaveBeenCalledTimes(1)
  })

  it('destroys session on process swap and re-inits with --cdp', async () => {
    const tabs = new Map([['tab-1', 100]])
    const mgr = mockBrowserManager(tabs)
    const b = new AgentBrowserBridge(mgr)
    b.setActiveTab(100)

    const firstSpawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {
      snapshot: 'tree'
    })
    await b.snapshot()

    expect(firstSpawns.find(({ command }) => command[0] === 'snapshot')?.args).toContain('--cdp')

    tabs.set('tab-1', 200)
    const newWc = mockWebContents(200)
    webContentsFromIdMock.mockReturnValue(newWc)
    succeedWith(null)
    await b.onProcessSwap('tab-1', 200)

    const swappedSpawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {
      snapshot: 'new tree'
    })
    await b.snapshot()

    expect(swappedSpawns.findLast(({ command }) => command[0] === 'snapshot')?.args).toContain(
      '--cdp'
    )
  })

  it('moves a reload-replaced page to a new daemon only after the old one exits', async () => {
    const tabs = new Map([['tab-1', 100]])
    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    Object.assign(b, {
      ownsAgentBrowserSocketDirectory: true,
      agentBrowserEnv: { AGENT_BROWSER_SOCKET_DIR: '/tmp/orca-ab-test' }
    })
    let daemon: 'none' | 'up' | 'exiting' = 'none'
    const commandsSentToExitingDaemon: string[] = []
    lstatSyncMock.mockImplementation(() => {
      if (daemon === 'none') {
        throw Object.assign(new Error('No socket'), { code: 'ENOENT' })
      }
      return {}
    })
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) => {
      if (command[0] === 'close') {
        // agent-browser answers close, then exits and removes its socket about 100 ms later.
        daemon = 'exiting'
        setTimeout(() => (daemon = 'none'), 50)
      } else {
        if (daemon === 'exiting') {
          commandsSentToExitingDaemon.push(command[0])
        }
        daemon = 'up'
      }
      cb(null, JSON.stringify({ success: true, data: { snapshot: 'tree' } }), '')
    })
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 ? mockWebContents(100) : null
    )
    await b.snapshot(undefined, 'tab-1')

    // The reload destroyed guest 100 and unregistered it, so the new guest has nothing to swap from.
    tabs.set('tab-1', 200)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 200 ? mockWebContents(200) : null
    )
    await b.snapshot(undefined, 'tab-1')

    expect(CdpWsProxyMock.mock.lastCall?.[0]).toMatchObject({ id: 200 })
    expect(closeCallCount()).toBe(1)
    expect(commandsSentToExitingDaemon).toEqual([])
  })

  it('rejects commands queued behind a running command when the page swaps guests', async () => {
    const tabs = new Map([['tab-1', 100]])
    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(100)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 || id === 200 ? mockWebContents(id) : null
    )

    let finishSnapshot: (() => void) | null = null
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb, _args, child) => {
      if (command[0] === 'snapshot') {
        finishSnapshot = () =>
          cb(null, JSON.stringify({ success: true, data: { snapshot: 'x' } }), '')
        child.kill.mockImplementation(() => finishSnapshot?.())
        return
      }
      cb(null, JSON.stringify({ success: true, data: null }), '')
    })

    const snapshot = b.snapshot(undefined, 'tab-1')
    await vi.waitFor(() => expect(finishSnapshot).not.toBeNull())
    const click = b.mouseClick(10, 20, 'left', undefined, 'tab-1')

    tabs.set('tab-1', 200)
    await b.onProcessSwap('tab-1', 200, 100)

    await expect(click).rejects.toMatchObject({ code: 'browser_tab_closed' })
    await snapshot.catch(() => {})
  })

  it('replays saved intercept routes onto the new guest after a process swap', async () => {
    const tabs = new Map([['tab-1', 100]])
    const b = new AgentBrowserBridge(mockBrowserManager(tabs))
    b.setActiveTab(100)
    webContentsFromIdMock.mockImplementation((id: number) =>
      id === 100 || id === 200 ? mockWebContents(id) : null
    )
    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, { ok: true })

    await b.interceptEnable(['https://old.example/**'])
    tabs.set('tab-1', 200)
    await b.onProcessSwap('tab-1', 200, 100)
    await expect(b.exec('get title')).resolves.toEqual({ ok: true })

    const routeSpawns = spawns.filter(({ command }) => isNetworkCommand(command, 'route'))
    expect(routeSpawns).toHaveLength(2)
    expect(routeSpawns.at(-1)?.command).toContain('https://old.example/**')
    expect(routeSpawns.at(-1)?.args).toContain('--cdp')
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

    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, { ok: true })

    await b.interceptDisable()

    expect(spawns.filter(({ command }) => isNetworkCommand(command, 'route'))).toHaveLength(0)
    expect(spawns.find(({ command }) => isNetworkCommand(command, 'unroute'))?.args).toContain(
      '--cdp'
    )
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

    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, { ok: true })

    await b.interceptEnable(['https://new.example/**'])

    const routeSpawns = spawns.filter(({ command }) => isNetworkCommand(command, 'route'))
    expect(routeSpawns).toHaveLength(1)
    expect(routeSpawns[0].command).toContain('https://new.example/**')
    expect(routeSpawns[0].command).not.toContain('https://old.example/**')
    expect(routeSpawns[0].args).toContain('--cdp')
  })

  it('replays intercept routes after the daemon idles out', async () => {
    succeedWith({ ok: true })
    await bridge.interceptEnable(['https://api.example/**'])

    const sessions = (bridge as unknown as { sessions: Map<string, { lastCommandAt: number }> })
      .sessions
    const session = sessions.get('orca-tab-tab-1')!
    session.lastCommandAt = Date.now() - 11 * 60 * 1000

    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {
      snapshot: 'tree'
    })
    await bridge.snapshot()

    const routeSpawns = spawns.filter(({ command }) => isNetworkCommand(command, 'route'))
    expect(routeSpawns).toHaveLength(1)
    expect(routeSpawns[0].command).toContain('https://api.example/**')
  })

  it('leaves a session alone while the daemon is still within its idle bound', async () => {
    succeedWith({ ok: true })
    await bridge.interceptEnable(['https://api.example/**'])

    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {
      snapshot: 'tree'
    })
    await bridge.snapshot()

    expect(spawns.filter(({ command }) => isNetworkCommand(command, 'route'))).toHaveLength(0)
  })

  it('makes runtime-wide session destruction terminal', async () => {
    succeedWith({ snapshot: 'tree' })
    await bridge.snapshot()

    succeedWith(null)
    await bridge.destroyAllSessions()
    execFileMock.mockClear()

    await expect(bridge.snapshot()).rejects.toMatchObject({
      code: 'browser_owner_unavailable',
      message: 'Browser runtime is shutting down'
    })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('bounds concurrent helper retirements during runtime shutdown', async () => {
    const sessions = (bridge as unknown as { sessions: Map<string, unknown> }).sessions
    for (let index = 0; index < 6; index++) {
      sessions.set(`orca-tab-tab-${index}`, {
        proxy: { stop: vi.fn(async () => {}) },
        cdpEndpoint: `ws://127.0.0.1:${9200 + index}`,
        initialized: true,
        consecutiveTimeouts: 0,
        activeInterceptPatterns: [],
        activeCapture: false,
        webContentsId: 100 + index,
        activeProcess: null
      })
    }

    let activeRetirements = 0
    let peakRetirements = 0
    const releases: (() => void)[] = []
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        activeRetirements++
        peakRetirements = Math.max(peakRetirements, activeRetirements)
        releases.push(() => {
          activeRetirements--
          cb(null, JSON.stringify({ success: true, data: null }), '')
        })
        return createFakeAgentBrowserChild({ kill: vi.fn() })
      }
    )

    const shutdown = bridge.destroyAllSessions()
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(4))
    releases.splice(0).forEach((release) => release())
    await vi.waitFor(() => expect(execFileMock).toHaveBeenCalledTimes(6))
    releases.splice(0).forEach((release) => release())
    await shutdown

    expect(peakRetirements).toBe(4)
  })
})
