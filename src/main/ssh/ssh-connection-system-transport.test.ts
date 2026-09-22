import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clientInstances,
  findSystemSshMock,
  getOrcaControlSocketPathMock,
  removeControlSocketPathMock,
  resetSshConnectionMocks,
  spawnSystemSshCommandMock,
  spawnSystemSshMock,
  ssh2Mock
} from './ssh-connection-test-harness'
import {
  createCallbacks,
  createFailingSystemCommandChannel,
  createHangingSystemCommandChannel,
  createPendingSystemSshProcess,
  createResolvedConfig,
  createSystemCommandChannel,
  createSystemSshProcess,
  createTarget
} from './ssh-connection-test-fixtures'
import { SshConnection, shouldUseSystemSshTransport } from './ssh-connection'
import { resolveWithSshG } from './ssh-config-parser'
import { writeFileViaSystemSsh } from './ssh-system-fallback'
import { CONNECT_TIMEOUT_MS } from './ssh-connection-utils'
import type { SshTarget } from '../../shared/ssh-types'
import {
  createOpenSshPrivateKeyFixture,
  createOpenSshPublicKeyFixture
} from './ssh-security-key-identity.test-fixture'

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

  it('uses system SSH transport when ProxyUseFdpass is resolved by OpenSSH', async () => {
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await conn.connect()

    expect(conn.getState().status).toBe('connected')
    expect(conn.usesSystemSshTransport()).toBe(true)
    expect(conn.getState().supportsFolderDownload).toBe(false)
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

  it('retries a generic system SSH probe timeout without ControlMaster', async () => {
    vi.useFakeTimers()
    try {
      getOrcaControlSocketPathMock.mockImplementation(
        (_target: SshTarget, options?: { disableControlMaster?: boolean }) =>
          options?.disableControlMaster ? null : '/tmp/orca-ssh-501/stale-socket'
      )
      spawnSystemSshCommandMock
        .mockImplementationOnce(() => createHangingSystemCommandChannel())
        .mockImplementation(() => createSystemCommandChannel())
      vi.mocked(resolveWithSshG).mockResolvedValue(createResolvedConfig())
      const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

      const settled = conn.connect()
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)

      await expect(settled).resolves.toBeUndefined()
      expect(spawnSystemSshCommandMock).toHaveBeenCalledTimes(2)
      expect(removeControlSocketPathMock).toHaveBeenCalledWith('/tmp/orca-ssh-501/stale-socket')
      expect(spawnSystemSshCommandMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        'echo ORCA-SYSTEM-SSH-OK',
        expect.objectContaining({ disableControlMaster: true })
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips a second probe for a definite host failure', async () => {
    getOrcaControlSocketPathMock.mockReturnValue('/tmp/orca-ssh-501/stale-socket')
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(255, 'ssh: connect to host box port 22: No route to host')
    )
    vi.mocked(resolveWithSshG).mockResolvedValue(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await expect(conn.connect()).rejects.toThrow('No route to host')
    expect(spawnSystemSshCommandMock).toHaveBeenCalledTimes(1)
    expect(removeControlSocketPathMock).toHaveBeenCalledWith('/tmp/orca-ssh-501/stale-socket')
  })

  it.each([
    'Permission denied (publickey,password).',
    'Encrypted private key detected, but no passphrase given'
  ])('skips a second probe for terminal credential failures: %s', async (stderr) => {
    getOrcaControlSocketPathMock.mockReturnValue('/tmp/orca-ssh-501/stale-socket')
    spawnSystemSshCommandMock.mockImplementation(() =>
      createFailingSystemCommandChannel(255, stderr)
    )
    vi.mocked(resolveWithSshG).mockResolvedValue(createResolvedConfig())
    const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

    await expect(conn.connect()).rejects.toThrow(stderr)
    expect(spawnSystemSshCommandMock).toHaveBeenCalledTimes(1)
    expect(removeControlSocketPathMock).toHaveBeenCalledWith('/tmp/orca-ssh-501/stale-socket')
  })

  it('retries a generic direct system SSH timeout without ControlMaster', async () => {
    vi.useFakeTimers()
    try {
      getOrcaControlSocketPathMock.mockImplementation(
        (_target: SshTarget, options?: { disableControlMaster?: boolean }) =>
          options?.disableControlMaster ? null : '/tmp/orca-ssh-501/stale-socket'
      )
      spawnSystemSshMock
        .mockImplementationOnce(() => createPendingSystemSshProcess())
        .mockImplementation(() => createSystemSshProcess())
      vi.mocked(resolveWithSshG).mockResolvedValue(createResolvedConfig())
      const conn = new SshConnection(createTarget({ configHost: 'fdpass-host' }), createCallbacks())

      const settled = conn.connectViaSystemSsh()
      await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS)

      await expect(settled).resolves.toBeDefined()
      expect(spawnSystemSshMock).toHaveBeenCalledTimes(2)
      expect(removeControlSocketPathMock).toHaveBeenCalledWith('/tmp/orca-ssh-501/stale-socket')
      expect(spawnSystemSshMock).toHaveBeenNthCalledWith(
        2,
        expect.anything(),
        expect.objectContaining({ disableControlMaster: true })
      )
    } finally {
      vi.useRealTimers()
    }
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

  it('uses system SSH before ssh2 parses a security-key private key', async () => {
    findSystemSshMock.mockReturnValue('/usr/bin/ssh')
    const directory = mkdtempSync(join(tmpdir(), 'orca-security-key-connect-'))
    const keyPath = join(directory, 'id_ed25519_sk')
    writeFileSync(
      keyPath,
      createOpenSshPrivateKeyFixture(['sk-ssh-ed25519@openssh.com'], { encrypted: true })
    )
    const conn = new SshConnection(createTarget({ identityFile: keyPath }), createCallbacks())

    try {
      await conn.connect()

      expect(conn.getState().status).toBe('connected')
      expect(conn.usesSystemSshTransport()).toBe(true)
      expect(clientInstances).toHaveLength(0)
      expect(spawnSystemSshCommandMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  it('uses system SSH for an agent-backed security-key public identity', async () => {
    findSystemSshMock.mockReturnValue('/usr/bin/ssh')
    const directory = mkdtempSync(join(tmpdir(), 'orca-security-key-agent-connect-'))
    const identityPath = join(directory, 'id_ed25519_sk')
    writeFileSync(
      `${identityPath}.pub`,
      createOpenSshPublicKeyFixture('sk-ssh-ed25519@openssh.com')
    )
    const conn = new SshConnection(createTarget({ identityFile: identityPath }), createCallbacks())

    try {
      await conn.connect()

      expect(conn.usesSystemSshTransport()).toBe(true)
      expect(clientInstances).toHaveLength(0)
      expect(spawnSystemSshCommandMock).toHaveBeenCalledTimes(1)
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  it('falls back to system SSH when ssh2 hits a local network policy reachability error', async () => {
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage =
      'connect EHOSTUNREACH 192.168.0.210:22 - Local (192.168.0.2:52112)'
    ssh2Mock.connectErrorCode = 'EHOSTUNREACH'
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
    ssh2Mock.connectBehavior = 'error'
    ssh2Mock.connectErrorMessage =
      'connect EHOSTUNREACH 192.168.0.210:22 - Local (192.168.0.2:52112)'
    ssh2Mock.connectErrorCode = 'EHOSTUNREACH'
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
    vi.unstubAllEnvs()
  })

  it('ignores stale imported proxy fields when fresh OpenSSH config has no proxy', () => {
    expect(
      shouldUseSystemSshTransport(
        createTarget({
          source: 'ssh-config',
          configHost: 'workbox',
          proxyCommand: 'ssh -W %h:%p stale-bastion'
        }),
        {
          proxyUseFdpass: false
        }
      )
    ).toBe(false)
  })
})
