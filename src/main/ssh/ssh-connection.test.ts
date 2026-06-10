/* eslint-disable max-lines -- Why: SSH connection lifecycle tests share one ssh2 mock so auth, reconnect, and system-transport behavior stay consistent. */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Socket } from 'net'
import { EventEmitter } from 'events'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let eventHandlers: Map<string, Set<(...args: unknown[]) => void>>
let connectBehavior: 'ready' | 'error' = 'ready'
let connectErrorMessage = ''
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
          emitSshEvent('error', new Error(connectErrorMessage))
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

const { spawnSystemSshCommandMock } = vi.hoisted(() => ({
  spawnSystemSshCommandMock: vi.fn()
}))

vi.mock('./ssh-system-fallback', () => ({
  spawnSystemSsh: vi.fn().mockReturnValue({
    stdin: {},
    stdout: {},
    stderr: {},
    kill: vi.fn(),
    onExit: vi.fn(),
    pid: 99999
  }),
  spawnSystemSshCommand: spawnSystemSshCommandMock,
  uploadDirectoryViaSystemSsh: vi.fn(),
  writeFileViaSystemSsh: vi.fn()
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
import { resolveWithSshG } from './ssh-config-parser'
import { uploadDirectoryViaSystemSsh, writeFileViaSystemSsh } from './ssh-system-fallback'
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

describe('SshConnection', () => {
  beforeEach(() => {
    eventHandlers = new Map()
    connectBehavior = 'ready'
    connectErrorMessage = ''
    destroyErrorMessage = ''
    connectSequence = []
    execBehavior = 'callback'
    pendingExecCallback = null
    sftpBehavior = 'callback'
    pendingSftpCallback = null
    clientInstances = []
    spawnSystemSshCommandMock.mockReset()
    spawnSystemSshCommandMock.mockImplementation(() => createSystemCommandChannel())
    vi.mocked(uploadDirectoryViaSystemSsh).mockReset()
    vi.mocked(uploadDirectoryViaSystemSsh).mockResolvedValue(undefined)
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
    vi.mocked(resolveWithSshG).mockResolvedValueOnce({
      hostname: 'example.com',
      port: 22,
      identityFile: [],
      forwardAgent: false,
      identitiesOnly: false,
      proxyUseFdpass: true
    })
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(clientInstances).toHaveLength(0)
    expect(spawnSystemSshCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'echo ORCA-SYSTEM-SSH-OK',
      { wrapCommand: false }
    )
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

  it('passes the detected host platform to system SSH file operations', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce({
      hostname: 'example.com',
      port: 22,
      identityFile: [],
      forwardAgent: false,
      identitiesOnly: false,
      proxyUseFdpass: true
    })
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
    const hostPlatform = getRemoteHostPlatform('win32-x64')

    await conn.connect()
    await conn.uploadDirectory('/tmp/local-relay', 'C:/Users/me/.orca-remote/relay', {
      hostPlatform
    })
    await conn.writeFile('C:/Users/me/.orca-remote/relay/.version', '0.1.0', {
      hostPlatform
    })

    expect(uploadDirectoryViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      '/tmp/local-relay',
      'C:/Users/me/.orca-remote/relay',
      expect.objectContaining({ hostPlatform })
    )
    expect(writeFileViaSystemSsh).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'fdpass-host' }),
      'C:/Users/me/.orca-remote/relay/.version',
      '0.1.0',
      expect.objectContaining({ hostPlatform })
    )
  })

  it('removes system SSH probe listeners after timeout', async () => {
    vi.useFakeTimers()
    const channel = new EventEmitter() as ReturnType<typeof createSystemCommandChannel>
    channel.stdin = { end: vi.fn(), write: vi.fn() }
    channel.stderr = new EventEmitter()
    channel.close = vi.fn()
    spawnSystemSshCommandMock.mockReturnValueOnce(channel)
    vi.mocked(resolveWithSshG).mockResolvedValueOnce({
      hostname: 'example.com',
      port: 22,
      identityFile: [],
      forwardAgent: false,
      identitiesOnly: false,
      proxyUseFdpass: true
    })
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
