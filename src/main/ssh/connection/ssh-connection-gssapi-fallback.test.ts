import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientInstances, ssh2Mock } from '../__tests__/ssh-connection-test-client'
import { resetSshConnectionMocks, spawnSystemSshCommandMock } from './ssh-connection-test-harness'
import {
  createCallbacks,
  createFailingSystemCommandChannel,
  createResolvedConfig,
  createSystemCommandChannel,
  createTarget
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

  it('tries system SSH first for targets that explicitly request GSSAPI authentication', async () => {
    const conn = new SshConnection(createTarget({ gssapiAuthentication: true }), createCallbacks())

    await conn.connect()
    await conn.exec('echo after-connect')

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(clientInstances).toHaveLength(0)
    expect(spawnSystemSshCommandMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ gssapiAuthentication: true }),
      'echo ORCA-SYSTEM-SSH-OK',
      {
        gssapiOnly: true,
        wrapCommand: false
      }
    )
    expect(spawnSystemSshCommandMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ gssapiAuthentication: true }),
      'echo after-connect',
      { gssapiOnly: true }
    )
  })

  it('tries GSSAPI first for a manually owned config-picker target', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ proxyUseFdpass: false, gssapiAuthentication: true })
    )
    const conn = new SshConnection(
      createTarget({
        source: 'manual',
        configHost: 'prod',
        host: 'prod.internal',
        gssapiAuthentication: true
      }),
      createCallbacks()
    )

    await conn.connect()

    expect(spawnSystemSshCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'manual', configHost: 'prod' }),
      'echo ORCA-SYSTEM-SSH-OK',
      expect.objectContaining({ gssapiOnly: true, wrapCommand: false })
    )
    expect(clientInstances).toHaveLength(0)
  })

  it('falls back to ssh2 when the GSSAPI-first system SSH attempt fails', async () => {
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(255, 'Permission denied (gssapi-with-mic,publickey)')
    )
    const conn = new SshConnection(createTarget({ gssapiAuthentication: true }), createCallbacks())

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(clientInstances).toHaveLength(1)
    expect(spawnSystemSshCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ gssapiAuthentication: true }),
      'echo ORCA-SYSTEM-SSH-OK',
      {
        gssapiOnly: true,
        wrapCommand: false
      }
    )
  })

  it('ignores stale imported GSSAPI when fresh OpenSSH config disables it', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ proxyUseFdpass: false, gssapiAuthentication: false })
    )
    const conn = new SshConnection(
      createTarget({
        source: 'ssh-config',
        configHost: 'krb-host',
        gssapiAuthentication: true
      }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
  })

  it('falls back to system SSH after an ssh2 auth failure when resolved config enables GSSAPI', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage = 'All configured authentication methods failed'
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ proxyUseFdpass: false, gssapiAuthentication: true })
    )
    const onCredentialRequest = vi.fn(async () => 'password-123')
    const conn = new SshConnection(
      createTarget({ configHost: 'krb-host' }),
      createCallbacks({ onCredentialRequest })
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(conn.getHostKeyFingerprint()).toBeUndefined()
    expect(onCredentialRequest).not.toHaveBeenCalled()
  })

  it('connects through the GSSAPI fallback without credential callbacks (headless)', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage = 'All configured authentication methods failed'
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ proxyUseFdpass: false, gssapiAuthentication: true })
    )
    const conn = new SshConnection(createTarget({ configHost: 'krb-host' }), createCallbacks())

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
  })

  it('keeps prompting for credentials when the GSSAPI fallback probe fails', async () => {
    // identityAgent none disables agents on every OS; empty SSH_AUTH_SOCK alone leaves Windows' agent pipe and changes retry order.
    vi.stubEnv('SSH_AUTH_SOCK', '')
    ssh2Mock.connectSequence = [new Error('All configured authentication methods failed'), 'ready']
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(255, 'Permission denied (gssapi-with-mic,password)')
    )
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({
        proxyUseFdpass: false,
        gssapiAuthentication: true,
        identityAgent: 'none'
      })
    )
    const onCredentialRequest = vi.fn(async () => 'password-123')
    const conn = new SshConnection(
      createTarget({ configHost: 'krb-host' }),
      createCallbacks({ onCredentialRequest })
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(spawnSystemSshCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'krb-host' }),
      'echo ORCA-SYSTEM-SSH-OK',
      expect.objectContaining({ wrapCommand: false })
    )
    expect(onCredentialRequest).toHaveBeenCalledWith(
      'target-1',
      'password',
      'example.com',
      undefined,
      expect.any(AbortSignal)
    )
  })

  it('tries the GSSAPI probe before prompting for an encrypted key passphrase', async () => {
    // Try a valid Kerberos ticket before prompting for the encrypted key after agent/key failure.
    vi.stubEnv('SSH_AUTH_SOCK', '/tmp/agent.sock')
    const tempDir = mkdtempSync(join(tmpdir(), 'orca-ssh-key-'))
    const keyPath = join(tempDir, 'id_ed25519')
    writeFileSync(keyPath, 'test-key')
    ssh2Mock.connectSequence = [
      new Error('All configured authentication methods failed'),
      new Error('Encrypted private OpenSSH key detected, but no passphrase given')
    ]
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ proxyUseFdpass: false, gssapiAuthentication: true })
    )
    const order: string[] = []
    spawnSystemSshCommandMock.mockImplementation(() => {
      order.push('probe')
      return createSystemCommandChannel()
    })
    const onCredentialRequest = vi.fn(async () => {
      order.push('prompt')
      return 'secret'
    })

    try {
      const conn = new SshConnection(
        createTarget({ configHost: 'krb-host', identityFile: keyPath }),
        createCallbacks({ onCredentialRequest })
      )

      await conn.connect()

      expect(conn.getState().status).toBe('connected')
      expect(conn.usesSystemSshTransport()).toBe(true)
      expect(order[0]).toBe('probe')
      expect(onCredentialRequest).not.toHaveBeenCalled()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('does not try system SSH for auth failures when resolved config leaves GSSAPI off', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage = 'All configured authentication methods failed'
    vi.mocked(resolveWithSshG).mockResolvedValue(createResolvedConfig({ proxyUseFdpass: false }))
    const conn = new SshConnection(createTarget({ configHost: 'plain-host' }), createCallbacks())

    await expect(conn.connect()).rejects.toThrow('All configured authentication methods failed')
    expect(conn.getState().status).toBe('auth-failed')
    expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
  })

  it('publishes auth-failed when OpenSSH denies reconnect credentials', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValue(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())
    await conn.connect()

    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(255, 'Permission denied (publickey,password).')
    )
    await conn.reconnect()

    expect(conn.getState().status).toBe('auth-failed')
  })

  it('clears system SSH transport when the GSSAPI-first probe throws synchronously', async () => {
    // Missing system ssh can throw before probe handling; reset the transport flag so exec/SFTP cannot keep using it.
    spawnSystemSshCommandMock.mockImplementation(() => {
      throw new Error('No system ssh binary found. Install OpenSSH.')
    })
    ssh2Mock.connectSequence = ['ready']
    const conn = new SshConnection(createTarget({ gssapiAuthentication: true }), createCallbacks())

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(false)
    expect(clientInstances).toHaveLength(1)
  })

  it('keeps disconnected state when a disconnect cancels the reactive GSSAPI probe', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage = 'All configured authentication methods failed'
    vi.mocked(resolveWithSshG).mockResolvedValue(
      createResolvedConfig({ proxyUseFdpass: false, gssapiAuthentication: true })
    )
    // Hold the probe channel until disconnect bumps generation and closes it, exercising cancellation instead of failure.
    let pendingChannel: ReturnType<typeof createSystemCommandChannel> | null = null
    spawnSystemSshCommandMock.mockImplementation(() => {
      const channel = new EventEmitter() as ReturnType<typeof createSystemCommandChannel>
      channel.stdin = { end: vi.fn(), write: vi.fn() }
      channel.stderr = new EventEmitter()
      channel.close = vi.fn(() => channel.emit('close', null))
      pendingChannel = channel
      return channel
    })
    const onStateChange = vi.fn()
    const conn = new SshConnection(
      createTarget({ configHost: 'krb-host' }),
      createCallbacks({ onStateChange })
    )

    const connectPromise = conn.connect()
    // Wait until the reactive probe has spawned its (never-closing) channel.
    await vi.waitFor(() => expect(pendingChannel).not.toBeNull())

    await conn.disconnect()
    await connectPromise.catch(() => {})

    expect(conn.getState().status).toBe('disconnected')
    const statuses = onStateChange.mock.calls.map((call) => call[1].status)
    expect(statuses).not.toContain('auth-failed')
    expect(statuses).not.toContain('error')
  })
})
