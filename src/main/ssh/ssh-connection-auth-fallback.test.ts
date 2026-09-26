import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clientInstances,
  emitSshEvent,
  nextSshClientCreation,
  resetSshConnectionMocks,
  ssh2Mock
} from './ssh-connection-test-harness'
import { createCallbacks, createResolvedConfig, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from './ssh-config-parser'
import { HostKeyVerificationError } from './ssh-host-key-decision'

vi.mock('ssh2', async () => (await import('./ssh-connection-test-harness')).createSsh2Module())
vi.mock('./system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('./ssh-system-fallback', async () =>
  (await import('./ssh-connection-test-harness')).createSystemFallbackModule()
)
vi.mock('./ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('./ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)

describe('SshConnection', () => {
  beforeEach(() => {
    resetSshConnectionMocks()
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
    ssh2Mock.connectSequence = [new Error('All configured authentication methods failed'), 'ready']

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
    ssh2Mock.connectSequence = [agentError, 'ready']

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
    ssh2Mock.connectSequence = [
      new Error('Received disconnect: Too many authentication failures'),
      'ready'
    ]

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
    ssh2Mock.connectSequence = [agentError, 'ready']
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
    expect(onCredentialRequest).toHaveBeenCalledWith(
      'target-1',
      'password',
      'example.com',
      expect.any(AbortSignal)
    )
  })

  it('retries password auth with a clean config after direct key fallback fails', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    ssh2Mock.connectSequence = [
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
      expect(keyRetryConfig.agent).toBeUndefined()
      expect(keyRetryConfig.privateKey).toEqual(Buffer.from('test-key'))
      expect(clientInstances[2].lastConnectConfig).toMatchObject({ password: 'password-123' })
      expect(clientInstances[2].lastConnectConfig).not.toHaveProperty('agent')
      expect(clientInstances[2].lastConnectConfig).not.toHaveProperty('privateKey')
      expect(clientInstances[2].lastConnectConfig).not.toHaveProperty('passphrase')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('answers bounded keyboard-interactive challenges such as Duo 2FA', async () => {
    vi.useFakeTimers()
    const onCredentialRequest = vi.fn().mockResolvedValueOnce('1').mockResolvedValueOnce('123456')
    try {
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))
      const clientCreated = nextSshClientCreation()
      const connected = conn.connect()
      await clientCreated
      const finish = vi.fn()

      emitSshEvent(
        'keyboard-interactive',
        'Duo two-factor login',
        'Select push or enter a passcode.',
        '',
        [
          { prompt: 'Option:', echo: false },
          { prompt: 'Passcode:', echo: false }
        ],
        finish
      )
      for (let turn = 0; turn < 8 && finish.mock.calls.length === 0; turn += 1) {
        await Promise.resolve()
      }

      expect(clientInstances[0].lastConnectConfig).toMatchObject({ tryKeyboard: true })
      expect(onCredentialRequest).toHaveBeenNthCalledWith(
        1,
        'target-1',
        'keyboard-interactive',
        'Duo two-factor login\nSelect push or enter a passcode.\nOption:',
        expect.any(AbortSignal)
      )
      expect(onCredentialRequest).toHaveBeenNthCalledWith(
        2,
        'target-1',
        'keyboard-interactive',
        'Duo two-factor login\nSelect push or enter a passcode.\nPasscode:',
        expect.any(AbortSignal)
      )
      expect(finish).toHaveBeenCalledWith(['1', '123456'])

      await vi.advanceTimersByTimeAsync(1)
      await connected
    } finally {
      vi.useRealTimers()
    }
  })

  it('rearms the handshake budget for each slow prompt in one keyboard-interactive round', async () => {
    vi.useFakeTimers()
    ssh2Mock.connectBehavior = 'pending'
    const firstResponse = Promise.withResolvers<string | null>()
    const secondResponse = Promise.withResolvers<string | null>()
    const onCredentialRequest = vi
      .fn()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise)
    try {
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))
      const clientCreated = nextSshClientCreation()
      const connected = conn.connect()
      let settled = false
      void connected.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      await clientCreated
      await vi.advanceTimersByTimeAsync(1)
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        'Duo two-factor login',
        'Complete both checks.',
        '',
        [
          { prompt: 'Option:', echo: false },
          { prompt: 'Passcode:', echo: false }
        ],
        finish
      )

      await vi.advanceTimersByTimeAsync(100_000)
      firstResponse.resolve('1')
      for (let turn = 0; turn < 4 && onCredentialRequest.mock.calls.length < 2; turn += 1) {
        await Promise.resolve()
      }
      expect(onCredentialRequest).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(settled).toBe(false)
      expect(finish).not.toHaveBeenCalled()

      secondResponse.resolve('123456')
      for (let turn = 0; turn < 4 && finish.mock.calls.length === 0; turn += 1) {
        await Promise.resolve()
      }
      expect(finish).toHaveBeenCalledWith(['1', '123456'])
      emitSshEvent('ready')
      await connected
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts an in-flight keyboard challenge when the connection is disconnected', async () => {
    vi.useFakeTimers()
    ssh2Mock.connectBehavior = 'pending'
    let credentialSignal: AbortSignal | undefined
    const onCredentialRequest = vi.fn(
      (_targetId: string, _kind: string, _detail: string, signal?: AbortSignal) => {
        credentialSignal = signal
        const response = Promise.withResolvers<string | null>()
        if (signal?.aborted) {
          response.resolve(null)
        } else {
          signal?.addEventListener('abort', () => response.resolve(null), { once: true })
        }
        return response.promise
      }
    )
    try {
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))
      const clientCreated = nextSshClientCreation()
      const connected = conn.connect()
      const connectionResult = connected.then(
        () => null,
        (error: unknown) => error
      )
      await clientCreated
      await vi.advanceTimersByTimeAsync(1)
      const finish = vi.fn()
      emitSshEvent(
        'keyboard-interactive',
        'Duo two-factor login',
        'Approve the push.',
        '',
        [{ prompt: 'Response:', echo: false }],
        finish
      )
      await Promise.resolve()
      expect(credentialSignal?.aborted).toBe(false)

      await conn.disconnect()
      expect(credentialSignal?.aborted).toBe(true)
      await expect(connectionResult).resolves.toBeInstanceOf(Error)
      for (let turn = 0; turn < 4 && finish.mock.calls.length === 0; turn += 1) {
        await Promise.resolve()
      }
      expect(finish).toHaveBeenCalledWith([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back from an agent through an encrypted key to password auth', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    ssh2Mock.connectSequence = [
      new Error('All configured authentication methods failed'),
      new Error('Encrypted private OpenSSH key detected, but no passphrase given')
    ]
    ssh2Mock.connectSequence.push('ready')
    const onCredentialRequest = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('password-123')

    try {
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath }),
        createCallbacks({ onCredentialRequest })
      )

      await conn.connect()

      expect(clientInstances).toHaveLength(3)
      expect(clientInstances[0].lastConnectConfig).toMatchObject({
        agent: '/tmp/agent.sock'
      })
      expect(clientInstances[0].lastConnectConfig).not.toHaveProperty('privateKey')
      expect(clientInstances[1].lastConnectConfig).toMatchObject({
        privateKey: Buffer.from('test-key')
      })
      expect(clientInstances[1].lastConnectConfig).not.toHaveProperty('agent')
      expect(clientInstances[2].lastConnectConfig).toMatchObject({ password: 'password-123' })
      expect(clientInstances[2].lastConnectConfig).not.toHaveProperty('agent')
      expect(clientInstances[2].lastConnectConfig).not.toHaveProperty('privateKey')
      expect(clientInstances[2].lastConnectConfig).not.toHaveProperty('passphrase')
      expect(onCredentialRequest).toHaveBeenNthCalledWith(
        1,
        'target-1',
        'passphrase',
        keyPath,
        expect.any(AbortSignal)
      )
      expect(onCredentialRequest).toHaveBeenNthCalledWith(
        2,
        'target-1',
        'password',
        'example.com',
        expect.any(AbortSignal)
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('uses password-only auth when an auto-detected encrypted key passphrase is cancelled', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'encrypted-key')
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ identityFile: [keyPath], proxyUseFdpass: false })
    )
    ssh2Mock.connectSequence = [
      new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
      'ready'
    ]
    const onCredentialRequest = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('password-123')

    try {
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      await conn.connect()

      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[1].lastConnectConfig).toMatchObject({ password: 'password-123' })
      expect(clientInstances[1].lastConnectConfig).not.toHaveProperty('agent')
      expect(clientInstances[1].lastConnectConfig).not.toHaveProperty('privateKey')
      expect(clientInstances[1].lastConnectConfig).not.toHaveProperty('passphrase')
      expect(onCredentialRequest.mock.calls.map((call) => call[1])).toEqual([
        'passphrase',
        'password'
      ])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('falls back to password after an invalid passphrase without caching it', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'encrypted-key')
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ identityFile: [keyPath], proxyUseFdpass: false })
    )
    ssh2Mock.connectSequence = [
      new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
      new Error('Cannot parse privateKey: OpenSSH key integrity check failed -- bad passphrase?'),
      'ready'
    ]
    const onCredentialRequest = vi
      .fn()
      .mockResolvedValueOnce('wrong-passphrase')
      .mockResolvedValueOnce('password-123')

    try {
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      await conn.connect()

      expect(clientInstances).toHaveLength(3)
      expect(clientInstances[1].lastConnectConfig).toMatchObject({
        privateKey: Buffer.from('encrypted-key'),
        passphrase: 'wrong-passphrase'
      })
      expect(clientInstances[2].lastConnectConfig).toMatchObject({ password: 'password-123' })
      expect(clientInstances[2].lastConnectConfig).not.toHaveProperty('agent')
      expect(clientInstances[2].lastConnectConfig).not.toHaveProperty('privateKey')
      expect(clientInstances[2].lastConnectConfig).not.toHaveProperty('passphrase')

      ssh2Mock.connectSequence = ['ready']
      await conn.connect()
      expect(clientInstances[3].lastConnectConfig).toMatchObject({ password: 'password-123' })
      expect(clientInstances[3].lastConnectConfig).not.toHaveProperty('passphrase')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('uses an explicitly selected encrypted key when its passphrase is correct', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'selected-key')
    writeFileSync(keyPath, 'encrypted-key')
    ssh2Mock.connectSequence = [
      new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
      'ready'
    ]
    const onCredentialRequest = vi.fn(async () => 'correct-passphrase')

    try {
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath }),
        createCallbacks({ onCredentialRequest })
      )

      await conn.connect()

      expect(clientInstances).toHaveLength(2)
      expect(clientInstances[1].lastConnectConfig).toMatchObject({
        privateKey: Buffer.from('encrypted-key'),
        passphrase: 'correct-passphrase'
      })
      expect(onCredentialRequest).toHaveBeenCalledTimes(1)
      expect(onCredentialRequest).toHaveBeenCalledWith(
        'target-1',
        'passphrase',
        keyPath,
        expect.any(AbortSignal)
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('reuses an accepted passphrase after a transient connection failure', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'selected-key')
    writeFileSync(keyPath, 'encrypted-key')
    ssh2Mock.connectSequence = [
      new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
      new Error('read ECONNRESET'),
      'ready'
    ]
    const onCredentialRequest = vi.fn(async () => 'correct-passphrase')

    try {
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath }),
        createCallbacks({ onCredentialRequest })
      )

      await conn.connect()

      expect(clientInstances).toHaveLength(3)
      expect(clientInstances[2].lastConnectConfig).toMatchObject({
        privateKey: Buffer.from('encrypted-key'),
        passphrase: 'correct-passphrase'
      })
      expect(onCredentialRequest).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not request a password when host-key verification rejects the passphrase retry', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'encrypted-key')
    ssh2Mock.connectSequence = [
      new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
      new HostKeyVerificationError('Host key verification failed', 'mismatch')
    ]
    const onCredentialRequest = vi.fn(async () => 'passphrase')

    try {
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath }),
        createCallbacks({ onCredentialRequest })
      )

      await expect(conn.connect()).rejects.toThrow('Host key verification failed')
      expect(onCredentialRequest).toHaveBeenCalledTimes(1)
      expect(onCredentialRequest).toHaveBeenCalledWith(
        'target-1',
        'passphrase',
        keyPath,
        expect.any(AbortSignal)
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('stops after one password failure without caching the rejected password', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'encrypted-key')
    ssh2Mock.connectSequence = [
      new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
      new Error('All configured authentication methods failed')
    ]
    const onCredentialRequest = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('wrong-password')

    try {
      const conn = new SshConnection(
        createTarget({ identityFile: keyPath }),
        createCallbacks({ onCredentialRequest })
      )

      await expect(conn.connect()).rejects.toThrow('All configured authentication methods failed')
      expect(conn.getState().status).toBe('auth-failed')
      expect(clientInstances).toHaveLength(2)
      expect(onCredentialRequest).toHaveBeenCalledTimes(2)

      ssh2Mock.connectSequence = [
        new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
        'ready'
      ]
      onCredentialRequest.mockResolvedValueOnce(null).mockResolvedValueOnce('correct-password')

      await conn.connect()

      expect(clientInstances).toHaveLength(4)
      expect(clientInstances[3].lastConnectConfig).toMatchObject({
        password: 'correct-password'
      })
      expect(onCredentialRequest).toHaveBeenNthCalledWith(
        4,
        'target-1',
        'password',
        'example.com',
        expect.any(AbortSignal)
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
