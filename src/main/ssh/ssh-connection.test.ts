/* eslint-disable max-lines -- Why: SSH connection lifecycle tests share one ssh2 mock so auth, reconnect, and system-transport behavior stay consistent. */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Socket } from 'node:net'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let eventHandlers: Map<string, Set<(...args: unknown[]) => void>>
let connectBehavior: 'ready' | 'error' = 'ready'
let connectErrorMessage = ''
let connectErrorCode = ''
let destroyErrorMessage = ''
let connectSequence: ('ready' | Error)[] = []
let execBehavior: 'callback' | 'pending' = 'callback'
let pendingExecCallback: ((err: Error | undefined, channel: unknown) => void) | null = null
let sftpBehavior: 'callback' | 'pending' = 'callback'
let pendingSftpCallback: ((err: Error | undefined, channel: unknown) => void) | null = null

type MockSshClient = {
  setNoDelay: ReturnType<typeof vi.fn>
  _sock: Socket | undefined
  lastExecCommand?: string
  lastConnectConfig?: unknown
  exec: (cmd: string, cb: (err: Error | undefined, channel: unknown) => void) => void
}
let clientInstances: MockSshClient[] = []

function emitSshEvent(event: string, ...args: unknown[]): void {
  for (const handler of eventHandlers?.get(event) ?? []) {
    handler(...args)
  }
}

vi.mock('ssh2', () => {
  class MockBaseAgent {}
  class MockSshClient {
    setNoDelay = vi.fn()
    // Why: production code reads `client._sock` and checks `instanceof net.Socket`
    // to decide which log line to emit. A real Socket instance lets the test
    // exercise the "enabled" branch instead of the "skipped (proxy socket)" branch.
    _sock: Socket | undefined = new Socket()
    lastExecCommand?: string
    lastConnectConfig?: unknown
    constructor() {
      clientInstances.push(this)
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = eventHandlers?.get(event) ?? new Set<(...args: unknown[]) => void>()
      handlers.add(handler)
      eventHandlers?.set(event, handlers)
    }
    off(event: string, handler: (...args: unknown[]) => void) {
      const handlers = eventHandlers?.get(event)
      handlers?.delete(handler)
      if (handlers?.size === 0) {
        eventHandlers.delete(event)
      }
    }
    connect(config?: unknown) {
      this.lastConnectConfig = config
      setTimeout(() => {
        const next = connectSequence.shift()
        if (next instanceof Error) {
          emitSshEvent('error', next)
          return
        }
        if (next === 'ready') {
          emitSshEvent('ready')
          return
        }
        if (connectBehavior === 'error') {
          const err = new Error(connectErrorMessage) as NodeJS.ErrnoException
          if (connectErrorCode) {
            err.code = connectErrorCode
          }
          emitSshEvent('error', err)
        } else {
          emitSshEvent('ready')
        }
      }, 0)
    }
    end() {}
    destroy() {
      if (!destroyErrorMessage) {
        return
      }
      if (eventHandlers?.has('error')) {
        emitSshEvent('error', new Error(destroyErrorMessage))
        return
      }
      throw new Error(destroyErrorMessage)
    }
    exec(cmd: string, cb: (err: Error | undefined, channel: unknown) => void) {
      this.lastExecCommand = cmd
      if (execBehavior === 'pending') {
        pendingExecCallback = cb
        return
      }
      cb(undefined, { close: vi.fn() })
    }
    sftp(cb: (err: Error | undefined, channel: unknown) => void) {
      if (sftpBehavior === 'pending') {
        pendingSftpCallback = cb
        return
      }
      cb(undefined, { end: vi.fn() })
    }
  }
  return {
    BaseAgent: MockBaseAgent,
    Client: MockSshClient,
    createAgent: vi.fn(),
    utils: {
      parseKey: vi.fn()
    }
  }
})

const {
  getOrcaControlSocketPathMock,
  removeControlSocketPathMock,
  spawnSystemSshCommandMock,
  spawnSystemSshMock
} = vi.hoisted(() => ({
  getOrcaControlSocketPathMock: vi.fn(),
  removeControlSocketPathMock: vi.fn(),
  spawnSystemSshMock: vi.fn(),
  spawnSystemSshCommandMock: vi.fn()
}))

vi.mock('./ssh-system-fallback', () => ({
  getOrcaControlSocketPath: getOrcaControlSocketPathMock,
  spawnSystemSsh: spawnSystemSshMock,
  spawnSystemSshCommand: spawnSystemSshCommandMock,
  downloadFileViaSystemSsh: vi.fn(),
  uploadDirectoryViaSystemSsh: vi.fn(),
  uploadFileViaSystemSsh: vi.fn(),
  writeBufferViaSystemSsh: vi.fn(),
  writeFileViaSystemSsh: vi.fn()
}))

vi.mock('./ssh-control-socket', () => ({
  removeControlSocketPath: removeControlSocketPathMock
}))

vi.mock('./ssh-config-parser', () => ({
  resolveWithSshG: vi.fn().mockResolvedValue(null)
}))

import {
  SshConnection,
  SshConnectionManager,
  shouldUseSystemSshTransport,
  type SshConnectionCallbacks
} from './ssh-connection'
import { resolveWithSshG, type SshResolvedConfig } from './ssh-config-parser'
import {
  downloadFileViaSystemSsh,
  uploadDirectoryViaSystemSsh,
  uploadFileViaSystemSsh,
  writeBufferViaSystemSsh,
  writeFileViaSystemSsh
} from './ssh-system-fallback'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshTarget } from '../../shared/ssh-types'

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

function createResolvedConfig(overrides?: Partial<SshResolvedConfig>): SshResolvedConfig {
  return {
    hostname: 'example.com',
    port: 22,
    identityFile: [],
    forwardAgent: false,
    identitiesOnly: false,
    proxyUseFdpass: true,
    controlMaster: 'no',
    controlPersist: 'no',
    ...overrides
  }
}

function createCallbacks(overrides?: Partial<SshConnectionCallbacks>): SshConnectionCallbacks {
  return {
    onStateChange: vi.fn(),
    ...overrides
  }
}

function createSystemCommandChannel(): EventEmitter & {
  stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }
  stderr: EventEmitter
  close: ReturnType<typeof vi.fn>
} {
  const channel = new EventEmitter() as EventEmitter & {
    stdin: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }
    stderr: EventEmitter
    close: ReturnType<typeof vi.fn>
  }
  channel.stdin = { end: vi.fn(), write: vi.fn() }
  channel.stderr = new EventEmitter()
  channel.close = vi.fn()
  queueMicrotask(() => {
    channel.emit('data', Buffer.from('ORCA-SYSTEM-SSH-OK'))
    channel.emit('close', 0)
  })
  return channel
}

function createFailingSystemCommandChannel(
  code: number,
  stderrText = ''
): ReturnType<typeof createSystemCommandChannel> {
  const channel = new EventEmitter() as ReturnType<typeof createSystemCommandChannel>
  channel.stdin = { end: vi.fn(), write: vi.fn() }
  channel.stderr = new EventEmitter()
  channel.close = vi.fn()
  queueMicrotask(() => {
    if (stderrText) {
      channel.stderr.emit('data', Buffer.from(stderrText))
    }
    channel.emit('close', code)
  })
  return channel
}

function createPendingSystemSshProcess() {
  const stdout = new EventEmitter()
  return {
    stdin: {},
    stdout,
    stderr: new EventEmitter(),
    kill: vi.fn(),
    onExit: vi.fn(),
    pid: 99999
  }
}

function createSystemSshProcess() {
  const proc = createPendingSystemSshProcess()
  queueMicrotask(() => {
    proc.stdout.emit('data', Buffer.from('ORCA-SYSTEM-SSH-READY'))
  })
  return proc
}

function createFailingSystemSshProcess(code: number) {
  const proc = createPendingSystemSshProcess()
  proc.onExit = vi.fn((handler: (exitCode: number | null) => void) => {
    queueMicrotask(() => handler(code))
  })
  return proc
}

describe('SshConnection', () => {
  beforeEach(() => {
    eventHandlers = new Map()
    connectBehavior = 'ready'
    connectErrorMessage = ''
    connectErrorCode = ''
    destroyErrorMessage = ''
    connectSequence = []
    execBehavior = 'callback'
    pendingExecCallback = null
    sftpBehavior = 'callback'
    pendingSftpCallback = null
    clientInstances = []
    getOrcaControlSocketPathMock.mockReset()
    getOrcaControlSocketPathMock.mockReturnValue(null)
    removeControlSocketPathMock.mockReset()
    spawnSystemSshMock.mockReset()
    spawnSystemSshMock.mockImplementation(() => createSystemSshProcess())
    spawnSystemSshCommandMock.mockReset()
    spawnSystemSshCommandMock.mockImplementation(() => createSystemCommandChannel())
    vi.mocked(downloadFileViaSystemSsh).mockReset()
    vi.mocked(downloadFileViaSystemSsh).mockResolvedValue(undefined)
    vi.mocked(uploadDirectoryViaSystemSsh).mockReset()
    vi.mocked(uploadDirectoryViaSystemSsh).mockResolvedValue(undefined)
    vi.mocked(uploadFileViaSystemSsh).mockReset()
    vi.mocked(uploadFileViaSystemSsh).mockResolvedValue(undefined)
    vi.mocked(writeBufferViaSystemSsh).mockReset()
    vi.mocked(writeBufferViaSystemSsh).mockResolvedValue(undefined)
    vi.mocked(writeFileViaSystemSsh).mockReset()
    vi.mocked(writeFileViaSystemSsh).mockResolvedValue(undefined)
    vi.mocked(resolveWithSshG).mockReset()
    vi.mocked(resolveWithSshG).mockResolvedValue(null)
    vi.unstubAllEnvs()
  })

  it('transitions to connected on successful connect', async () => {
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(callbacks.onStateChange).toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'connected' })
    )
  })

  it('enables TCP_NODELAY on the ssh2 client after ready', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    expect(clientInstances).toHaveLength(1)
    expect(clientInstances[0].setNoDelay).toHaveBeenCalledWith(true)
  })

  it('allows concurrent exec commands for ssh2 transport', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(conn.canRunConcurrentExecCommands()).toBe(true)
  })

  it('removes startup listeners after ssh2 connect succeeds', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())

    await conn.connect()

    expect(eventHandlers.has('ready')).toBe(false)
    // The remaining error listener is the steady-state disconnect handler.
    expect(eventHandlers.has('error')).toBe(true)
  })

  it('enables TCP_NODELAY on the new ssh2 client after a reconnect cycle', async () => {
    // Why: guards the "Nagle is re-enabled because someone refactored only
    // the initial connect path" regression class. attemptConnect bumps
    // connectGeneration on every call, and both the initial connect and the
    // explicit reconnect path go through doSsh2Connect → client.on('ready').
    // The new client must also receive setNoDelay(true).
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    expect(clientInstances).toHaveLength(1)
    expect(clientInstances[0].setNoDelay).toHaveBeenCalledWith(true)

    // Simulate the reconnect path: a fresh attemptConnect run via the
    // internal helper that scheduleReconnect uses. Easiest from the public
    // API is to call connect() again — disposed/connected guard rejects, so
    // we exercise the path via a private call. Use the bracket-access
    // form to keep the test free of `any` casts.
    const privateConn = conn as unknown as {
      attemptConnect: () => Promise<void>
    }
    await privateConn.attemptConnect()

    expect(clientInstances).toHaveLength(2)
    expect(clientInstances[1].setNoDelay).toHaveBeenCalledWith(true)
  })

  it('forces a fresh SSH connection for an explicit reconnect', async () => {
    const states: string[] = []
    const conn = new SshConnection(
      createTarget(),
      createCallbacks({
        onStateChange: vi.fn((_id, state) => states.push(state.status))
      })
    )
    await conn.connect()

    await conn.reconnect()

    expect(clientInstances).toHaveLength(2)
    expect(states).toEqual(['connecting', 'connected', 'reconnecting', 'connecting', 'connected'])
    expect(conn.getState().status).toBe('connected')
  })

  it('transitions through connecting → connected states', async () => {
    const states: string[] = []
    const callbacks = createCallbacks({
      onStateChange: vi.fn((_id, state) => states.push(state.status))
    })
    const conn = new SshConnection(createTarget(), callbacks)

    await conn.connect()

    expect(states).toContain('connecting')
    expect(states).toContain('connected')
  })

  it('reports error state on connection failure', async () => {
    connectBehavior = 'error'
    connectErrorMessage = 'Connection refused'

    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    await expect(conn.connect()).rejects.toThrow('Connection refused')
    expect(conn.getState().status).toBe('error')
  })

  it('guards late ssh2 errors emitted while destroying a failed startup client', async () => {
    connectBehavior = 'error'
    connectErrorMessage = 'Connection lost before handshake'
    destroyErrorMessage = 'Connection lost before handshake'
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)

    await expect(conn.connect()).rejects.toThrow('Connection lost before handshake')

    expect(conn.getState().status).toBe('error')
  })

  it('disconnect cleans up and sets state to disconnected', async () => {
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget(), callbacks)
    await conn.connect()

    await conn.disconnect()

    expect(conn.getState().status).toBe('disconnected')
  })

  it('getTarget returns a copy of the target', () => {
    const target = createTarget()
    const conn = new SshConnection(target, createCallbacks())
    const returned = conn.getTarget()

    expect(returned).toEqual(target)
    expect(returned).not.toBe(target)
  })

  it('getState returns a copy of the state', () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    const state1 = conn.getState()
    const state2 = conn.getState()

    expect(state1).toEqual(state2)
    expect(state1).not.toBe(state2)
  })

  it('throws when connecting a disposed connection', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.disconnect()

    await expect(conn.connect()).rejects.toThrow('Connection disposed')
  })

  it('resolves OpenSSH config using configHost when present', async () => {
    const callbacks = createCallbacks()
    const conn = new SshConnection(
      createTarget({
        label: 'Friendly Name',
        configHost: 'ssh-alias'
      }),
      callbacks
    )

    await conn.connect()

    expect(resolveWithSshG).toHaveBeenCalledWith('ssh-alias')
  })

  it('tries ssh-agent before reading an explicit private key', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const callbacks = createCallbacks({
      onCredentialRequest: vi.fn()
    })
    const conn = new SshConnection(
      createTarget({
        identityFile: '/tmp/encrypted-key'
      }),
      callbacks
    )

    await conn.connect()

    const initialConfig = clientInstances[0].lastConnectConfig as {
      agent?: unknown
      privateKey?: unknown
    }
    expect(initialConfig.agent).toBe('/tmp/agent.sock')
    expect(initialConfig.privateKey).toBeUndefined()
    expect(callbacks.onCredentialRequest).not.toHaveBeenCalled()
  })

  it('falls back to direct private key auth when agent auth fails', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    connectSequence = [new Error('All configured authentication methods failed'), 'ready']

    try {
      const conn = new SshConnection(createTarget({ identityFile: keyPath }), createCallbacks())

      await conn.connect()

      expect(clientInstances).toHaveLength(2)
      const initialConfig = clientInstances[0].lastConnectConfig as {
        agent?: unknown
        privateKey?: unknown
      }
      const fallbackConfig = clientInstances[1].lastConnectConfig as {
        agent?: unknown
        privateKey?: Buffer
      }
      expect(initialConfig.agent).toBe('/tmp/agent.sock')
      expect(initialConfig.privateKey).toBeUndefined()
      expect(fallbackConfig.agent).toBeUndefined()
      expect(fallbackConfig.privateKey).toEqual(Buffer.from('test-key'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('falls back to direct private key auth when the agent socket is unavailable', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/stale-agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    const agentError = new Error('Failed to connect to agent') as Error & { level: string }
    agentError.level = 'agent'
    connectSequence = [agentError, 'ready']

    try {
      const conn = new SshConnection(createTarget({ identityFile: keyPath }), createCallbacks())

      await conn.connect()

      expect(clientInstances).toHaveLength(2)
      const fallbackConfig = clientInstances[1].lastConnectConfig as {
        agent?: unknown
        privateKey?: Buffer
      }
      expect(fallbackConfig.agent).toBeUndefined()
      expect(fallbackConfig.privateKey).toEqual(Buffer.from('test-key'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('falls back to direct private key auth after too many agent authentication failures', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    connectSequence = [new Error('Received disconnect: Too many authentication failures'), 'ready']

    try {
      const conn = new SshConnection(createTarget({ identityFile: keyPath }), createCallbacks())

      await conn.connect()

      expect(clientInstances).toHaveLength(2)
      const fallbackConfig = clientInstances[1].lastConnectConfig as {
        agent?: unknown
        privateKey?: Buffer
      }
      expect(fallbackConfig.agent).toBeUndefined()
      expect(fallbackConfig.privateKey).toEqual(Buffer.from('test-key'))
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('retries password auth without a stale agent when no private key fallback exists', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/stale-agent.sock')
    const agentError = new Error('Failed to connect to agent') as Error & { level: string }
    agentError.level = 'agent'
    connectSequence = [agentError, 'ready']
    const onCredentialRequest = vi.fn(async () => 'password-123')
    const conn = new SshConnection(
      createTarget({ identityFile: join(tmpdir(), 'missing-key') }),
      createCallbacks({ onCredentialRequest })
    )

    await conn.connect()

    expect(clientInstances).toHaveLength(2)
    const retryConfig = clientInstances[1].lastConnectConfig as {
      agent?: unknown
      password?: string
      privateKey?: unknown
    }
    expect(retryConfig.agent).toBeUndefined()
    expect(retryConfig.password).toBe('password-123')
    expect(retryConfig.privateKey).toBeUndefined()
    expect(onCredentialRequest).toHaveBeenCalledWith('target-1', 'password', 'example.com')
  })

  it('retries password auth with the no-agent key config after direct key fallback fails', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    connectSequence = [
      new Error('All configured authentication methods failed'),
      new Error('All configured authentication methods failed'),
      'ready'
    ]
    const onCredentialRequest = vi.fn(async () => 'password-123')

    try {
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath }),
        createCallbacks({ onCredentialRequest })
      )

      await conn.connect()

      expect(clientInstances).toHaveLength(3)
      const keyRetryConfig = clientInstances[1].lastConnectConfig as {
        agent?: unknown
        privateKey?: Buffer
      }
      const passwordRetryConfig = clientInstances[2].lastConnectConfig as {
        agent?: unknown
        password?: string
        privateKey?: Buffer
      }
      expect(keyRetryConfig.agent).toBeUndefined()
      expect(keyRetryConfig.privateKey).toEqual(Buffer.from('test-key'))
      expect(passwordRetryConfig.agent).toBeUndefined()
      expect(passwordRetryConfig.privateKey).toEqual(Buffer.from('test-key'))
      expect(passwordRetryConfig.password).toBe('password-123')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not prompt twice when post-agent private key passphrase is cancelled', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    connectSequence = [
      new Error('All configured authentication methods failed'),
      new Error('Encrypted private OpenSSH key detected, but no passphrase given')
    ]
    const onCredentialRequest = vi.fn(async () => null)

    try {
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath }),
        createCallbacks({ onCredentialRequest })
      )

      await expect(conn.connect()).rejects.toThrow('Encrypted private OpenSSH key detected')
      expect(onCredentialRequest).toHaveBeenCalledTimes(1)
      expect(onCredentialRequest).toHaveBeenCalledWith('target-1', 'passphrase', keyPath)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('wraps exec commands in /bin/sh so non-POSIX login shells do not parse relay snippets', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    await conn.exec("cd '/tmp' && ('/usr/bin/node' -e 'console.log(1)' || echo MISSING)")

    expect(clientInstances[0].lastExecCommand).toBe(
      "exec /bin/sh -c 'cd '\\''/tmp'\\'' && ('\\''/usr/bin/node'\\'' -e '\\''console.log(1)'\\'' || echo MISSING)'"
    )
  })

  it('can execute native remote commands without the POSIX shell wrapper', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()

    await conn.exec('powershell.exe -NoProfile -EncodedCommand AAAA', { wrapCommand: false })

    expect(clientInstances[0].lastExecCommand).toBe(
      'powershell.exe -NoProfile -EncodedCommand AAAA'
    )
  })

  it('times out when ssh2 never opens an exec channel', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    execBehavior = 'pending'

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .exec('printf ready')
        .then(() => 'opened')
        .catch((error: Error) => error.message)

      await vi.advanceTimersByTimeAsync(30_000)
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('SSH exec channel timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a late exec callback after the channel-open timeout settles', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    execBehavior = 'pending'
    const lateChannel = { close: vi.fn() }

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .exec('printf ready')
        .then(() => 'opened')
        .catch((error: Error) => error.message)

      await vi.advanceTimersByTimeAsync(30_000)
      pendingExecCallback?.(undefined, lateChannel)

      await expect(outcomePromise).resolves.toBe('SSH exec channel timed out')
      expect(lateChannel.close).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries a session-limit-refused exec open and succeeds on a later attempt', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    const channel = { close: vi.fn() }
    const execMock = vi
      .fn<(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) => void>()
      .mockImplementationOnce((_cmd, cb) => {
        cb(
          Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 2 }),
          undefined
        )
      })
      .mockImplementation((_cmd, cb) => cb(undefined, channel))
    clientInstances[0].exec = execMock as never

    await expect(conn.exec('printf ready')).resolves.toBe(channel)
    expect(execMock).toHaveBeenCalledTimes(2)
  })

  it('surfaces the session-limit error once open retries are exhausted', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    const refusal = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 2
    })
    const execMock = vi
      .fn<(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) => void>()
      .mockImplementation((_cmd, cb) => cb(refusal, undefined))
    clientInstances[0].exec = execMock as never

    await expect(conn.exec('printf ready')).rejects.toBe(refusal)
    expect(execMock).toHaveBeenCalledTimes(4)
  })

  it('does not retry non-session-limit exec open failures', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    const failure = new Error('Not connected')
    const execMock = vi
      .fn<(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) => void>()
      .mockImplementation((_cmd, cb) => cb(failure, undefined))
    clientInstances[0].exec = execMock as never

    await expect(conn.exec('printf ready')).rejects.toBe(failure)
    expect(execMock).toHaveBeenCalledTimes(1)
  })

  it('bounds an aborted exec to the close grace when ssh2 never invokes the open callback', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    execBehavior = 'pending'
    const controller = new AbortController()

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .exec('printf ready', { signal: controller.signal })
        .then(() => 'opened')
        .catch((error: Error) => error.name)

      controller.abort()
      // Why: a hung socket must not pin the aborted caller for the full 30s
      // connect timeout — the abort settles at the 5s grace bound instead.
      await vi.advanceTimersByTimeAsync(5_000)

      await expect(outcomePromise).resolves.toBe('AbortError')
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects without waiting out the backoff when aborted during a session-limit retry delay', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    const controller = new AbortController()
    const refusal = Object.assign(new Error('(SSH) Channel open failure: open failed'), {
      reason: 2
    })
    const execMock = vi
      .fn<(cmd: string, cb: (err: Error | undefined, ch: unknown) => void) => void>()
      .mockImplementation((_cmd, cb) => cb(refusal, undefined))
    clientInstances[0].exec = execMock as never

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .exec('printf ready', { signal: controller.signal })
        .then(() => 'opened')
        .catch((error: Error) => error.name)

      // Flush microtasks so the first refused attempt lands in the backoff.
      await vi.advanceTimersByTimeAsync(0)
      controller.abort()

      // No timer advance: the abort alone must release the backoff delay.
      await expect(outcomePromise).resolves.toBe('AbortError')
      expect(execMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles an abort during channel open only after the late channel closes', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    execBehavior = 'pending'
    const controller = new AbortController()
    const lateChannel = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      resume: vi.fn(),
      stderr: { resume: vi.fn() }
    })

    const outcomePromise = conn
      .exec('printf ready', { signal: controller.signal })
      .then(() => 'opened')
      .catch((error: Error) => error.name)

    await Promise.resolve()
    controller.abort()
    pendingExecCallback?.(undefined, lateChannel)

    // Why: the sshd session slot is freed only when the channel finishes
    // closing — settling before 'close' lets the next open race the close.
    const early = await Promise.race([outcomePromise, Promise.resolve('pending')])
    expect(early).toBe('pending')
    expect(lateChannel.close).toHaveBeenCalledTimes(1)
    expect(lateChannel.resume).toHaveBeenCalled()

    lateChannel.emit('close')
    await expect(outcomePromise).resolves.toBe('AbortError')
  })

  it('times out when ssh2 never opens an SFTP channel', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    sftpBehavior = 'pending'

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .sftp()
        .then(() => 'opened')
        .catch((error: Error) => error.message)

      await vi.advanceTimersByTimeAsync(30_000)
      const outcome = await Promise.race([outcomePromise, Promise.resolve('pending')])

      expect(outcome).toBe('SSH SFTP channel timed out')
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a late SFTP callback after the channel-open timeout settles', async () => {
    const conn = new SshConnection(createTarget(), createCallbacks())
    await conn.connect()
    sftpBehavior = 'pending'
    const lateSftp = { end: vi.fn() }

    vi.useFakeTimers()
    try {
      const outcomePromise = conn
        .sftp()
        .then(() => 'opened')
        .catch((error: Error) => error.message)

      await vi.advanceTimersByTimeAsync(30_000)
      pendingSftpCallback?.(undefined, lateSftp)

      await expect(outcomePromise).resolves.toBe('SSH SFTP channel timed out')
      expect(lateSftp.end).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses system SSH transport when ProxyUseFdpass is resolved by OpenSSH', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(clientInstances).toHaveLength(0)
    expect(spawnSystemSshCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'echo ORCA-SYSTEM-SSH-OK',
      {
        wrapCommand: false,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      }
    )
  })

  it('allows concurrent exec commands for system SSH with an Orca ControlMaster socket', async () => {
    getOrcaControlSocketPathMock.mockReturnValue('/tmp/orca-ssh-501/live-socket')
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await conn.connect()

    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(conn.canRunConcurrentExecCommands()).toBe(true)
  })

  it('keeps concurrent exec commands disabled for system SSH without a reusable socket', async () => {
    getOrcaControlSocketPathMock.mockReturnValue(null)
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(
      createTarget({ configHost: 'fdpass-host', systemSshConnectionReuse: false }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(conn.canRunConcurrentExecCommands()).toBe(false)
  })

  it('retries a failed system SSH probe without ControlMaster and disables mux for the session', async () => {
    getOrcaControlSocketPathMock.mockImplementation(
      (_target: SshTarget, options?: { disableControlMaster?: boolean }) =>
        options?.disableControlMaster ? null : '/tmp/orca-ssh-501/stale-socket'
    )
    spawnSystemSshCommandMock
      .mockImplementationOnce(() => createFailingSystemCommandChannel(255, 'mux client failed'))
      .mockImplementation(() => createSystemCommandChannel())
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await conn.connect()
    await conn.exec('echo after-connect')
    await conn.writeFile('/tmp/after-connect', 'contents')

    expect(removeControlSocketPathMock).toHaveBeenCalledWith('/tmp/orca-ssh-501/stale-socket')
    expect(spawnSystemSshCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'echo ORCA-SYSTEM-SSH-OK',
      expect.objectContaining({
        wrapCommand: false,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(spawnSystemSshCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'echo ORCA-SYSTEM-SSH-OK',
      expect.objectContaining({
        disableControlMaster: true,
        wrapCommand: false,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(spawnSystemSshCommandMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'echo after-connect',
      expect.objectContaining({
        disableControlMaster: true,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(writeFileViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      '/tmp/after-connect',
      'contents',
      expect.objectContaining({
        disableControlMaster: true,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(conn.canRunConcurrentExecCommands()).toBe(false)
  })

  it('uses system SSH transport for ProxyCommand targets before ssh2 auth', async () => {
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(clientInstances).toHaveLength(0)
    expect(spawnSystemSshCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      'echo ORCA-SYSTEM-SSH-OK',
      { wrapCommand: false }
    )
  })

  it('falls back to system SSH when ssh2 hits a local network policy reachability error', async () => {
    connectBehavior = 'error'
    connectErrorMessage = 'connect EHOSTUNREACH 192.168.0.210:22 - Local (192.168.0.2:52112)'
    connectErrorCode = 'EHOSTUNREACH'
    const conn = new SshConnection(
      createTarget({ host: '192.168.0.210', label: 'LAN Linux', username: 'hydra' }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(clientInstances).toHaveLength(1)
    expect(spawnSystemSshCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: '192.168.0.210' }),
      'echo ORCA-SYSTEM-SSH-OK',
      { wrapCommand: false }
    )
  })

  it('keeps the original ssh2 reachability error when the system SSH probe fails', async () => {
    connectBehavior = 'error'
    connectErrorMessage = 'connect EHOSTUNREACH 192.168.0.210:22 - Local (192.168.0.2:52112)'
    connectErrorCode = 'EHOSTUNREACH'
    spawnSystemSshCommandMock.mockImplementation(() => {
      throw new Error('No system ssh binary found. Install OpenSSH to use system SSH transport.')
    })
    const conn = new SshConnection(
      createTarget({ host: '192.168.0.210', label: 'LAN Linux', username: 'hydra' }),
      createCallbacks()
    )
    const privateConn = conn as unknown as {
      attemptConnect: () => Promise<void>
    }

    await expect(privateConn.attemptConnect()).rejects.toThrow(
      'connect EHOSTUNREACH 192.168.0.210:22'
    )
    expect(conn.usesSystemSshTransport()).toBe(false)
  })

  it('passes the detected host platform to system SSH file operations', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
    const hostPlatform = getRemoteHostPlatform('win32-x64')

    await conn.connect()
    await conn.uploadDirectory('/tmp/local-relay', 'C:/Users/me/.orca-remote/relay', {
      hostPlatform
    })
    await conn.writeFile('C:/Users/me/.orca-remote/relay/.version', '0.1.0', {
      hostPlatform
    })
    await conn.writeBuffer('C:/Users/me/.orca-remote/relay/logo.png', Buffer.from('png'), {
      hostPlatform,
      exclusive: true
    })
    await conn.downloadFile('C:/Users/me/.orca-remote/relay/logo.png', '/tmp/logo.png', {
      hostPlatform
    })
    const uploadSession = await conn.openFileUploadSession({ hostPlatform })
    await uploadSession.uploadFile('/tmp/logo.png', 'C:/Users/me/project/logo.png', {
      exclusive: true
    })
    uploadSession.close()

    expect(uploadDirectoryViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      '/tmp/local-relay',
      'C:/Users/me/.orca-remote/relay',
      expect.objectContaining({
        hostPlatform,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(writeFileViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'C:/Users/me/.orca-remote/relay/.version',
      '0.1.0',
      expect.objectContaining({
        hostPlatform,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(writeBufferViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'C:/Users/me/.orca-remote/relay/logo.png',
      Buffer.from('png'),
      expect.objectContaining({
        hostPlatform,
        exclusive: true,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(downloadFileViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'C:/Users/me/.orca-remote/relay/logo.png',
      '/tmp/logo.png',
      expect.objectContaining({
        hostPlatform,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
    expect(uploadFileViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      '/tmp/logo.png',
      'C:/Users/me/project/logo.png',
      expect.objectContaining({
        hostPlatform,
        exclusive: true,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      })
    )
  })

  it('keeps an upload session cancelled after the connection disconnects', async () => {
    const conn = new SshConnection(
      createTarget({ proxyCommand: 'ssh -W %h:%p bastion.example.com' }),
      createCallbacks()
    )
    vi.mocked(uploadFileViaSystemSsh).mockImplementation(
      async (_target, _localPath, _remotePath, options) => {
        if (options?.signal?.aborted) {
          const error = new Error('System SSH operation was cancelled')
          error.name = 'AbortError'
          throw error
        }
      }
    )

    await conn.connect()
    const uploadSession = await conn.openFileUploadSession()
    await conn.disconnect()

    await expect(
      uploadSession.uploadFile('/tmp/late.txt', '/remote/late.txt')
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(uploadFileViaSystemSsh).toHaveBeenCalledWith(
      expect.anything(),
      '/tmp/late.txt',
      '/remote/late.txt',
      expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) })
    )
  })

  it('removes system SSH probe listeners after timeout', async () => {
    vi.useFakeTimers()
    const channel = new EventEmitter() as ReturnType<typeof createSystemCommandChannel>
    channel.stdin = { end: vi.fn(), write: vi.fn() }
    channel.stderr = new EventEmitter()
    channel.close = vi.fn()
    spawnSystemSshCommandMock.mockReturnValueOnce(channel)
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    try {
      const connect = expect(conn.connect()).rejects.toThrow('System SSH connection timed out')
      await vi.advanceTimersByTimeAsync(30_000)

      await connect
      expect(channel.close).toHaveBeenCalled()
      expect(channel.listenerCount('data')).toBe(0)
      expect(channel.listenerCount('error')).toBe(1)
      expect(channel.listenerCount('close')).toBe(1)
      expect(channel.stderr.listenerCount('data')).toBe(0)
      expect(
        (conn as unknown as { systemCommandChannels: Set<unknown> }).systemCommandChannels.size
      ).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes resolved OpenSSH config to direct system SSH connections', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await conn.connectViaSystemSsh()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(spawnSystemSshMock).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      {
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      }
    )
  })

  it('retries direct system SSH connections without ControlMaster after mux startup failure', async () => {
    getOrcaControlSocketPathMock.mockImplementation(
      (_target: SshTarget, options?: { disableControlMaster?: boolean }) =>
        options?.disableControlMaster ? null : '/tmp/orca-ssh-501/stale-socket'
    )
    spawnSystemSshMock
      .mockReturnValueOnce(createFailingSystemSshProcess(255))
      .mockImplementation(() => createSystemSshProcess())
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await conn.connectViaSystemSsh()

    expect(removeControlSocketPathMock).toHaveBeenCalledWith('/tmp/orca-ssh-501/stale-socket')
    expect(spawnSystemSshMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ configHost: 'fdpass-host' }),
      {
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      }
    )
    expect(spawnSystemSshMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ configHost: 'fdpass-host' }),
      {
        disableControlMaster: true,
        resolvedConfig: expect.objectContaining({ proxyUseFdpass: true })
      }
    )
    expect(conn.canRunConcurrentExecCommands()).toBe(false)
  })

  it('kills delayed direct system SSH startup on disconnect and ignores late stdout', async () => {
    const proc = createPendingSystemSshProcess()
    spawnSystemSshMock.mockReturnValueOnce(proc)
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), callbacks)

    const connectResult = conn.connectViaSystemSsh().catch((err: Error) => err)
    for (let i = 0; i < 5 && spawnSystemSshMock.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(spawnSystemSshMock).toHaveBeenCalledTimes(1)

    await conn.disconnect()

    expect(proc.kill).toHaveBeenCalled()
    proc.stdout.emit('data', Buffer.from('ORCA-SYSTEM-SSH-READY'))

    await expect(connectResult).resolves.toMatchObject({
      message: 'SSH connection attempt was cancelled'
    })
    expect(conn.getState().status).toBe('disconnected')
    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'connected' })
    )
  })

  it('treats delayed direct system SSH exit after disconnect as cancellation', async () => {
    const proc = createPendingSystemSshProcess()
    let capturedExit: ((exitCode: number | null) => void) | null = null
    proc.onExit = vi.fn((handler: (exitCode: number | null) => void) => {
      capturedExit = handler
    })
    proc.kill = vi.fn(() => {
      queueMicrotask(() => capturedExit?.(null))
    })
    spawnSystemSshMock.mockReturnValueOnce(proc)
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const callbacks = createCallbacks()
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), callbacks)

    const connectResult = conn.connectViaSystemSsh().catch((err: Error) => err)
    for (let i = 0; i < 5 && spawnSystemSshMock.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }
    expect(spawnSystemSshMock).toHaveBeenCalledTimes(1)

    await conn.disconnect()

    const result = await connectResult
    expect(result).toBeInstanceOf(Error)
    if (!(result instanceof Error)) {
      throw new Error('Expected direct system SSH startup to reject')
    }
    expect(result.message).toBe('SSH connection attempt was cancelled')
    expect(conn.getState()).toMatchObject({ status: 'disconnected', error: null })
    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'error' })
    )
    expect(callbacks.onStateChange).not.toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ status: 'connected' })
    )
  })

  it('does not spawn direct system SSH after disconnect while OpenSSH config is resolving', async () => {
    let resolveConfig!: (config: SshResolvedConfig | null) => void
    vi.mocked(resolveWithSshG).mockReturnValueOnce(
      new Promise<SshResolvedConfig | null>((resolve) => {
        resolveConfig = resolve
      })
    )
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    const connectResult = conn.connectViaSystemSsh().catch((err: Error) => err)
    await Promise.resolve()
    await conn.disconnect()
    resolveConfig(createResolvedConfig())

    await expect(connectResult).resolves.toMatchObject({
      message: 'SSH connection attempt was cancelled'
    })
    expect(spawnSystemSshMock).not.toHaveBeenCalled()
    expect(conn.getState().status).toBe('disconnected')
  })

  it('does not spawn direct system SSH retry after cancellation between mux failure and retry', async () => {
    getOrcaControlSocketPathMock.mockReturnValue('/tmp/orca-ssh-501/stale-socket')
    const firstProc = createPendingSystemSshProcess()
    let conn!: SshConnection
    firstProc.onExit = vi.fn((handler: (exitCode: number | null) => void) => {
      queueMicrotask(() => {
        handler(255)
        void conn.disconnect()
      })
    })
    spawnSystemSshMock
      .mockReturnValueOnce(firstProc)
      .mockImplementation(() => createSystemSshProcess())
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    const result = await conn.connectViaSystemSsh().catch((err: Error) => err)

    expect(result).toMatchObject({ message: 'SSH connection attempt was cancelled' })
    expect(spawnSystemSshMock).toHaveBeenCalledTimes(1)
    expect(conn.getState().status).toBe('disconnected')
  })
})

describe('shouldUseSystemSshTransport', () => {
  it('uses system transport for target or resolved OpenSSH proxy directives', () => {
    expect(shouldUseSystemSshTransport(createTarget(), { proxyUseFdpass: true })).toBe(true)
    expect(shouldUseSystemSshTransport(createTarget(), { proxyUseFdpass: false })).toBe(false)
    expect(
      shouldUseSystemSshTransport(createTarget({ proxyCommand: 'ssh -W %h:%p bastion' }), null)
    ).toBe(true)
    expect(shouldUseSystemSshTransport(createTarget({ jumpHost: 'bastion' }), null)).toBe(true)
    expect(
      shouldUseSystemSshTransport(createTarget(), {
        proxyUseFdpass: false,
        proxyCommand: 'ssh -W %h:%p bastion'
      })
    ).toBe(true)
    expect(
      shouldUseSystemSshTransport(createTarget(), {
        proxyUseFdpass: false,
        proxyJump: 'bastion'
      })
    ).toBe(true)
  })

  it('allows an environment override for e2e coverage', () => {
    vi.stubEnv('ORCA_SSH_FORCE_SYSTEM_TRANSPORT', '1')
    expect(shouldUseSystemSshTransport(createTarget(), null)).toBe(true)
  })
})

describe('SshConnectionManager', () => {
  beforeEach(() => {
    eventHandlers = new Map()
    connectBehavior = 'ready'
    connectErrorMessage = ''
    connectSequence = []
    clientInstances = []
  })

  it('connect creates and stores a connection', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget()

    const conn = await mgr.connect(target)
    expect(conn.getState().status).toBe('connected')
    expect(mgr.getConnection(target.id)).toBe(conn)
  })

  it('getState returns connection state', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget()

    await mgr.connect(target)
    const state = mgr.getState(target.id)

    expect(state).toBeTruthy()
    expect(state!.status).toBe('connected')
  })

  it('getState returns null for unknown targets', () => {
    const mgr = new SshConnectionManager(createCallbacks())
    expect(mgr.getState('unknown')).toBeNull()
  })

  it('disconnect removes the connection', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget()

    await mgr.connect(target)
    await mgr.disconnect(target.id)

    expect(mgr.getConnection(target.id)).toBeUndefined()
  })

  it('disconnect is a no-op for unknown targets', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    await mgr.disconnect('unknown')
  })

  it('reuses existing connected connection for same target', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    const target = createTarget()

    const conn1 = await mgr.connect(target)
    const conn2 = await mgr.connect(target)

    expect(conn2).toBe(conn1)
  })

  it('getAllStates returns all connection states', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    await mgr.connect(createTarget({ id: 'a' }))
    await mgr.connect(createTarget({ id: 'b' }))

    const states = mgr.getAllStates()
    expect(states.size).toBe(2)
    expect(states.get('a')?.status).toBe('connected')
    expect(states.get('b')?.status).toBe('connected')
  })

  it('disconnectAll disconnects all connections', async () => {
    const mgr = new SshConnectionManager(createCallbacks())
    await mgr.connect(createTarget({ id: 'a' }))
    await mgr.connect(createTarget({ id: 'b' }))

    await mgr.disconnectAll()

    expect(mgr.getConnection('a')).toBeUndefined()
    expect(mgr.getConnection('b')).toBeUndefined()
  })
})
