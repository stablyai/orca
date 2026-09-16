import { describe, expect, it, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clientInstances,
  resetSshConnectionMocks,
  spawnSystemSshCommandMock,
  ssh2Mock
} from './ssh-connection-test-harness'
import {
  createCallbacks,
  createFailingSystemCommandChannel,
  createResolvedConfig,
  createSystemCommandChannel,
  createTarget
} from './ssh-connection-test-fixtures'
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
    // Why: proves the GSSAPI-first probe actually ran before the ssh2 fallback,
    // so the test fails if the proactive block is removed.
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
    // Why: identityAgent 'none' makes resolveAgentSocket return undefined on
    // every platform (SSH_AUTH_SOCK='' alone leaves the Windows agent pipe), so
    // ssh2's first connect carries any default key directly and the agent
    // fallback retry never consumes the second ssh2Mock.connectSequence entry —
    // deterministic on dev machines with both ~/.ssh/id_* and a live agent.
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
    // Why: proves the reactive GSSAPI probe actually ran before prompting, so
    // the test fails if the reactive fallback block is removed.
    expect(spawnSystemSshCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ configHost: 'krb-host' }),
      'echo ORCA-SYSTEM-SSH-OK',
      expect.objectContaining({ wrapCommand: false })
    )
    expect(onCredentialRequest).toHaveBeenCalledWith(
      'target-1',
      'password',
      'example.com',
      expect.any(AbortSignal)
    )
  })

  it('tries the GSSAPI probe before prompting for an encrypted key passphrase', async () => {
    // Why: a valid Kerberos ticket should connect silently before the user is
    // ever asked for the key passphrase. Agent auth fails, the explicit-key
    // retry fails with a passphrase error, and resolved GSSAPI is on — so the
    // reactive probe must run before onCredentialRequest.
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
      // Why: the probe must precede any passphrase prompt (which here never runs).
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
    // Why: no system ssh binary makes spawnSystemSshCommand throw before the
    // probe's try/catch, so the ssh2 fall-through must still reset the flag —
    // otherwise exec/sftp keep routing through the unusable system transport.
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
    // Why: a probe channel that stays open until close() leaves the reactive
    // fallback pending, so we can disconnect mid-probe; disconnect() then calls
    // close() (bumping the generation first), which settles the probe as a
    // cancellation rather than a probe failure.
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
