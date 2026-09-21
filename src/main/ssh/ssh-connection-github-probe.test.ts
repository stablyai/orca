import { describe, expect, it, vi, beforeEach } from 'vitest'
import { resetSshConnectionMocks, spawnSystemSshCommandMock } from './ssh-connection-test-harness'
import {
  createCallbacks,
  createFailingSystemCommandChannel,
  createResolvedConfig,
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

  it('accepts GitHub restricted-shell SSH probes with resolved user fallback', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'github.com', user: 'git' })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(1, 'Invalid command: echo ORCA-SYSTEM-SSH-OK')
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'github.com',
        host: 'github.com',
        username: undefined
      }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
  })

  it('uses fresh OpenSSH user for imported GitHub targets', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'github.com', user: 'git' })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(1, 'Invalid command: echo ORCA-SYSTEM-SSH-OK')
    )
    const conn = new SshConnection(
      createTarget({
        source: 'ssh-config',
        configHost: 'github.com',
        host: 'github.com',
        username: 'stale-user'
      }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
  })

  it('accepts GitHub restricted-shell SSH probes with resolved host and target username', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'github.com', user: undefined })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(1, 'Invalid command: echo ORCA-SYSTEM-SSH-OK')
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'github.com',
        host: 'github.com',
        username: 'git'
      }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
  })

  it('accepts ssh.github.com restricted-shell SSH probes', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'ssh.github.com', user: 'git' })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(1, 'Invalid command: echo ORCA-SYSTEM-SSH-OK')
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'ssh.github.com',
        host: 'ssh.github.com',
        username: 'git'
      }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
  })

  it('accepts GitHub restricted-shell SSH probes with the real git:// advisory transcript', async () => {
    // Real 4-line stderr GitHub returns for an invalid command (issue #6988).
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'github.com', user: 'git' })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(
        1,
        'Invalid command: echo ORCA-SYSTEM-SSH-OK\n' +
          '  You appear to be using ssh to clone a git:// URL.\n' +
          '  Make sure your core.gitProxy config option and the\n' +
          '  GIT_PROXY_COMMAND environment variable are NOT set.'
      )
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'github.com',
        host: 'github.com',
        username: 'git'
      }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
  })

  it('accepts GitHub restricted-shell SSH probes when OpenSSH config resolution fails', async () => {
    vi.stubEnv('ORCA_SSH_FORCE_SYSTEM_TRANSPORT', '1')
    vi.mocked(resolveWithSshG).mockRejectedValueOnce(new Error('ssh -G failed'))
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(1, 'Invalid command: echo ORCA-SYSTEM-SSH-OK')
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'github.com',
        host: 'github.com',
        username: 'git'
      }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(conn.getSystemSshResolvedConfig()).toBeNull()
  })

  it('rejects non-GitHub SSH probes with GitHub invalid-command text', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'gitlab.com', user: 'git' })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(1, 'Invalid command: echo ORCA-SYSTEM-SSH-OK')
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'github.com',
        host: 'github.com',
        username: 'git'
      }),
      createCallbacks()
    )

    await expect(conn.connect()).rejects.toThrow('System SSH probe failed (exit 1)')
    expect(conn.usesSystemSshTransport()).toBe(false)
  })

  it('accepts GitHub restricted-shell SSH probes when target username overrides resolved user', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'github.com', user: 'deploy' })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(1, 'Invalid command: echo ORCA-SYSTEM-SSH-OK')
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'github.com',
        host: 'github.com',
        username: 'git'
      }),
      createCallbacks()
    )

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
  })

  it('rejects GitHub restricted-shell SSH probes when target username overrides resolved git user', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'github.com', user: 'git' })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(1, 'Invalid command: echo ORCA-SYSTEM-SSH-OK')
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'github.com',
        host: 'github.com',
        username: 'deploy'
      }),
      createCallbacks()
    )

    await expect(conn.connect()).rejects.toThrow('System SSH probe failed (exit 1)')
    expect(conn.usesSystemSshTransport()).toBe(false)
  })

  it('rejects GitHub restricted-shell SSH probes with extra stderr text', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'github.com', user: 'git' })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(
        1,
        'remote: rejected\nInvalid command: echo ORCA-SYSTEM-SSH-OK\ntry again'
      )
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'github.com',
        host: 'github.com',
        username: 'git'
      }),
      createCallbacks()
    )

    await expect(conn.connect()).rejects.toThrow('System SSH probe failed (exit 1)')
    expect(conn.usesSystemSshTransport()).toBe(false)
  })

  it('rejects GitHub restricted-shell SSH probes for non-git users', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(
      createResolvedConfig({ hostname: 'github.com', user: 'deploy' })
    )
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(1, 'Invalid command: echo ORCA-SYSTEM-SSH-OK')
    )
    const conn = new SshConnection(
      createTarget({
        configHost: 'github.com',
        host: 'github.com',
        username: 'deploy'
      }),
      createCallbacks()
    )

    await expect(conn.connect()).rejects.toThrow('System SSH probe failed (exit 1)')
    expect(conn.usesSystemSshTransport()).toBe(false)
  })
})
