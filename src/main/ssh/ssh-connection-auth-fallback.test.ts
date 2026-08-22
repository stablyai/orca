import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientInstances, resetSshConnectionMocks, ssh2Mock } from './ssh-connection-test-harness'
import { createCallbacks, createTarget } from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import { resolveWithSshG } from './ssh-config-parser'

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
    expect(onCredentialRequest).toHaveBeenCalledWith('target-1', 'password', 'example.com')
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
      expect(onCredentialRequest).toHaveBeenCalledWith('target-1', 'passphrase', keyPath)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
