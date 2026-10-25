import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { utils } from 'ssh2'
import { clientInstances, emitSshEvent, ssh2Mock } from '../__tests__/ssh-connection-test-client'
import { nextSshClientCreation, resetSshConnectionMocks } from './ssh-connection-test-harness'
import {
  createCallbacks,
  createTarget,
  walkInitialAuthLadder
} from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from '../config/ssh-g-config-resolution'

vi.mock('ssh2', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2Module()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-args', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshArgsMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshCommandMocks(await importOriginal())
)
vi.mock('../system-transport/system-ssh-file-binary-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/system-ssh-file-transfer', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSystemSshFileTransferMocks(
    await importOriginal()
  )
)
vi.mock('../ssh-control-socket', async () =>
  (await import('./ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./ssh-connection-test-harness')).withSshGConfigResolutionMocks(
    await importOriginal()
  )
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

  it('holds the keyboard-interactive challenge until the deferred default key has been tried', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-home-'))
    mkdirSync(join(tempDir, '.ssh'))
    // Real key bytes and parser: deferral requires the waiting key to parse as unencrypted.
    const realSsh2 = await vi.importActual<{ utils: typeof utils }>('ssh2')
    const keyBytes = Buffer.from(realSsh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private)
    writeFileSync(join(tempDir, '.ssh', 'id_ed25519'), keyBytes)
    vi.mocked(utils.parseKey).mockImplementation(realSsh2.utils.parseKey)
    vi.stubEnv('HOME', tempDir)
    vi.stubEnv('USERPROFILE', tempDir)
    ssh2Mock.connectSequence = [new Error('All configured authentication methods failed'), 'ready']

    try {
      const onCredentialRequest = vi.fn()
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      await conn.connect()

      expect(clientInstances).toHaveLength(2)
      // The deferred default key must precede the password challenge after agent failure.
      expect(
        walkInitialAuthLadder(clientInstances[0].lastConnectConfig, [
          'publickey',
          'keyboard-interactive'
        ])
      ).toEqual(['none', 'agent'])
      expect(clientInstances[1].lastConnectConfig).toMatchObject({
        privateKey: keyBytes
      })
      expect(onCredentialRequest).not.toHaveBeenCalled()
    } finally {
      vi.mocked(utils.parseKey).mockReset()
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  describe('when the agent-first attempt held the challenge back for ~/.ssh/id_ed25519', () => {
    let tempDir: string
    const hostMethods = ['publickey' as const, 'keyboard-interactive' as const]
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

    beforeEach(async () => {
      vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
      tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-home-'))
      mkdirSync(join(tempDir, '.ssh'))
      // Real key bytes and parser: deferral requires the waiting key to parse as unencrypted.
      const realSsh2 = await vi.importActual<{ utils: typeof utils }>('ssh2')
      writeFileSync(
        join(tempDir, '.ssh', 'id_ed25519'),
        realSsh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private
      )
      vi.mocked(utils.parseKey).mockImplementation(realSsh2.utils.parseKey)
      vi.stubEnv('HOME', tempDir)
      vi.stubEnv('USERPROFILE', tempDir)
    })

    afterEach(() => {
      vi.mocked(utils.parseKey).mockReset()
      rmSync(tempDir, { recursive: true, force: true })
    })

    /** Runs the agent-first attempt to its skipped challenge and fails it, leaving the key retry. */
    async function failAgentFirstAttempt(
      conn: SshConnection
    ): Promise<{ connected: Promise<void> }> {
      const created = nextSshClientCreation()
      const connected = conn.connect()
      await created
      await settle()
      expect(walkInitialAuthLadder(clientInstances[0].lastConnectConfig, hostMethods)).toEqual([
        'none',
        'agent'
      ])
      const keyRetryCreated = nextSshClientCreation()
      emitSshEvent('error', new Error('All configured authentication methods failed'))
      await keyRetryCreated
      await settle()
      // Wrap the promise so this async fixture does not await connection completion.
      return { connected }
    }

    it('offers the challenge alone when a MaxAuthTries=1 host drops the key retry first', async () => {
      ssh2Mock.connectSequence = ['silent', 'silent', 'ready']
      const onCredentialRequest = vi.fn()
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      const { connected } = await failAgentFirstAttempt(conn)
      // The host disconnects after the rejected key, before the retry reaches keyboard-interactive.
      expect(walkInitialAuthLadder(clientInstances[1].lastConnectConfig, hostMethods, 2)).toEqual([
        'none',
        'publickey'
      ])
      const challengeCreated = nextSshClientCreation()
      emitSshEvent('error', new Error('Received disconnect: Too many authentication failures'))
      await challengeCreated
      await connected

      expect(clientInstances).toHaveLength(3)
      const challengeConfig = clientInstances[2].lastConnectConfig
      expect(challengeConfig).not.toHaveProperty('agent')
      expect(challengeConfig).not.toHaveProperty('privateKey')
      expect(walkInitialAuthLadder(challengeConfig, hostMethods)).toEqual([
        'none',
        'keyboard-interactive'
      ])
      expect(onCredentialRequest).not.toHaveBeenCalled()
    })

    it('does not repeat the challenge when the key retry already offered it', async () => {
      ssh2Mock.connectSequence = ['silent', 'silent']
      const onCredentialRequest = vi.fn(async () => null)
      const conn = new SshConnection(createTarget(), createCallbacks({ onCredentialRequest }))

      const { connected } = await failAgentFirstAttempt(conn)
      expect(walkInitialAuthLadder(clientInstances[1].lastConnectConfig, hostMethods)).toEqual([
        'none',
        'publickey',
        'keyboard-interactive'
      ])
      emitSshEvent('error', new Error('All configured authentication methods failed'))

      await expect(connected).rejects.toThrow('All configured authentication methods failed')
      expect(clientInstances).toHaveLength(2)
    })
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
      undefined,
      expect.any(AbortSignal)
    )
  })

  it('retries password auth with the no-agent key config after direct key fallback fails', async () => {
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
      for (let turn = 0; turn < 20 && finish.mock.calls.length === 0; turn += 1) {
        await Promise.resolve()
      }

      expect(clientInstances[0].lastConnectConfig).toMatchObject({ tryKeyboard: true })
      expect(onCredentialRequest).toHaveBeenNthCalledWith(
        1,
        'target-1',
        'keyboard-interactive',
        'Duo two-factor login\nSelect push or enter a passcode.\nOption:',
        false,
        expect.any(AbortSignal)
      )
      expect(onCredentialRequest).toHaveBeenNthCalledWith(
        2,
        'target-1',
        'keyboard-interactive',
        'Duo two-factor login\nSelect push or enter a passcode.\nPasscode:',
        false,
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
      for (let turn = 0; turn < 20 && onCredentialRequest.mock.calls.length < 2; turn += 1) {
        await Promise.resolve()
      }
      expect(onCredentialRequest).toHaveBeenCalledTimes(2)

      await vi.advanceTimersByTimeAsync(30_000)
      expect(settled).toBe(false)
      expect(finish).not.toHaveBeenCalled()

      secondResponse.resolve('123456')
      for (let turn = 0; turn < 20 && finish.mock.calls.length === 0; turn += 1) {
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
      (
        _targetId: string,
        _kind: string,
        _detail: string,
        _echo?: boolean,
        signal?: AbortSignal
      ) => {
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

  it('does not prompt twice when post-agent private key passphrase is cancelled', async () => {
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    ssh2Mock.connectSequence = [
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
      expect(onCredentialRequest).toHaveBeenCalledWith(
        'target-1',
        'passphrase',
        keyPath,
        undefined,
        expect.any(AbortSignal)
      )
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
