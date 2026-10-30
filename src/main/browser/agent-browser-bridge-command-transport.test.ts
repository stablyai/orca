import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  execFileMock,
  webContentsFromIdMock,
  existsSyncMock,
  readFileSyncMock,
  readFileMock,
  rmMock,
  createFromBufferMock,
  stdinWrites
} = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  webContentsFromIdMock: vi.fn(),
  existsSyncMock: vi.fn(() => false),
  readFileSyncMock: vi.fn(() => Buffer.from('')),
  readFileMock: vi.fn(),
  rmMock: vi.fn(async () => {}),
  createFromBufferMock: vi.fn(),
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
vi.mock('fs/promises', () => ({ readFile: readFileMock, rm: rmMock }))
vi.mock('os', () => ({ platform: () => 'darwin', arch: () => 'arm64' }))
vi.mock('electron', () => {
  return {
    app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
    webContents: { fromId: webContentsFromIdMock },
    nativeImage: { createFromBuffer: createFromBufferMock }
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
  agentBrowserCommandsIn,
  answerAgentBrowserCommands,
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

function failWith(error: string): void {
  execFileMock.mockImplementation(
    (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
      cb(null, JSON.stringify({ success: false, error }), '')
    }
  )
}

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
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

  it('passes typed snapshot options to agent-browser as its flags', async () => {
    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {
      snapshot: 'tree'
    })

    await bridge.snapshot(undefined, undefined, {
      interactive: true,
      compact: true,
      depth: 2,
      selector: '#main form',
      urls: true,
      delta: true
    })

    expect(spawns.find(({ command }) => command[0] === 'snapshot')?.command).toEqual([
      'snapshot',
      '-i',
      '-c',
      '-d',
      '2',
      '-s',
      '#main form',
      '-u',
      '--delta'
    ])
  })

  it('returns screenshots in CSS pixels and deletes the file agent-browser wrote', async () => {
    const wc = mockWebContents(100)
    // A 15px classic scrollbar narrows the CSS width; the height still gives the true 2x ratio.
    wc.debugger.sendCommand.mockResolvedValue({
      cssVisualViewport: { clientWidth: 785, clientHeight: 600 }
    })
    webContentsFromIdMock.mockReturnValue(wc)
    const resized = { toPNG: () => Buffer.from('css-png') }
    const resize = vi.fn(() => resized)
    createFromBufferMock.mockReturnValue({ resize })
    readFileMock.mockResolvedValue(pngHeader(1600, 1200))
    const spawns = succeedRecordingAgentBrowserSpawns(execFileMock, stdinWrites, {
      path: '/ab-tmp/shot.png',
      changed: true
    })

    await expect(bridge.screenshot({ ifChanged: true })).resolves.toEqual({
      data: Buffer.from('css-png').toString('base64'),
      format: 'png',
      changed: true
    })
    expect(spawns.find(({ command }) => command[0] === 'screenshot')?.command).toEqual([
      'screenshot',
      expect.stringMatching(/^\/app\/orca-screenshot-[\w-]+\.png$/),
      '--if-changed',
      '--screenshot-format',
      'png'
    ])
    expect(resize).toHaveBeenCalledWith({ width: 800, quality: 'best' })
    expect(rmMock).toHaveBeenCalledWith('/ab-tmp/shot.png', { force: true })
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

  it('drops the daemon lifecycle agent-browser adds to every result', async () => {
    // Real agent-browser 0.39.4 batch reply.
    const reply =
      '[{"command":["click","@e2"],"error":null,"result":{"clicked":"@e2","lifecycle":{"effectiveLaunch":{"browserLaunched":true,"engine":"chrome","launchHash":520248349195465926},"launched":false,"relaunchedBrowser":false,"restartedBackground":false,"restoreStatus":"not_configured","reused":true,"saveStatus":"not_attempted"}},"success":true}]'
    answerAgentBrowserCommands(execFileMock, stdinWrites, (_command, cb) => cb(null, reply, ''))
    await expect(bridge.click('@e2')).resolves.toEqual({ clicked: '@e2' })
  })

  it('returns every step of a passthrough batch, including one that failed', async () => {
    // Real agent-browser 0.39.4 reply; it exits 1 because a step failed.
    const reply =
      '[{"command":["get","title"],"error":null,"result":{"title":"Login","lifecycle":{"reused":true}},"success":true},{"command":["click","@e999"],"error":"Unknown ref: e999","result":null,"success":false}]'
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) =>
      command[0] === 'batch' ? cb(new Error('Command failed'), reply, '') : cb(null, '{}', '')
    )
    await expect(bridge.exec('batch "get title" "click @e999"')).resolves.toEqual([
      { command: ['get', 'title'], error: null, result: { title: 'Login' }, success: true },
      { command: ['click', '@e999'], error: 'Unknown ref: e999', result: null, success: false }
    ])
  })

  it('returns a passthrough batch that stopped at its first step as that step', async () => {
    // `batch --bail` whose first step fails replies with one entry, like Orca's own batches.
    const reply =
      '[{"command":["click","@e999"],"error":"Unknown ref: e999","result":null,"success":false}]'
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) =>
      command[0] === 'batch' ? cb(new Error('Command failed'), reply, '') : cb(null, '{}', '')
    )
    await expect(bridge.exec('batch --bail "click @e999" "get url"')).resolves.toEqual([
      { command: ['click', '@e999'], error: 'Unknown ref: e999', result: null, success: false }
    ])
  })

  it('ends stdin for passthrough commands so a bare batch does not wait for input', async () => {
    // Real agent-browser 0.39.4 reply to a batch whose stdin closed empty.
    const reply =
      '{"error":"Invalid JSON input: EOF while parsing a value at line 1 column 0.","success":false}'
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) =>
      command[0] === 'batch' ? cb(new Error('Command failed'), reply, '') : cb(null, '{}', '')
    )
    await expect(bridge.exec('batch')).rejects.toThrow('Invalid JSON input')
  })

  it("adds effects to an agent's click and costs a person's click nothing extra", async () => {
    webContentsFromIdMock.mockReturnValue(mockWebContents(100))
    answerAgentBrowserCommands(execFileMock, stdinWrites, (command, cb) => {
      const data =
        command[0] === 'snapshot'
          ? { snapshot: { kind: 'unchanged', baseRevision: 1, revision: 2 } }
          : { clicked: '@e2' }
      cb(null, JSON.stringify({ success: true, data }), '')
    })

    await expect(bridge.click('@e2')).resolves.toEqual({ clicked: '@e2' })
    expect(agentBrowserCommandsIn(stdinWrites)).toEqual([['click', '@e2']])

    const agentBridge = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, {
        beginAgentCommand: () => ({ agent: true, run: (execute) => execute(), end: () => {} }),
        observePageEvents: () => () => {}
      })
    )
    agentBridge.setActiveTab(100)
    await expect(agentBridge.click('@e2')).resolves.toMatchObject({
      clicked: '@e2',
      effects: { page: 'unchanged' }
    })
  })

  // agent-browser 0.39.2+ wording when it cannot re-resolve a ref by role and name.
  it.each([
    'Stale ref for role=button name=Approve cannot be recovered: several elements now match. Run snapshot again and use a fresh ref.',
    'Could not locate element with role=link name=Back to basic'
  ])('reports a ref whose element is gone as stale: %s', async (message) => {
    failWith(message)
    await expect(bridge.click('@e2')).rejects.toMatchObject({ code: 'browser_stale_ref' })
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
