import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clientInstances, ssh2Mock } from '../__tests__/ssh-connection-test-client'
import {
  findSystemSshMock,
  getOrcaControlSocketPathMock,
  removeControlSocketPathMock,
  resetSshConnectionMocks,
  spawnSystemSshCommandMock
} from './ssh-connection-test-harness'
import {
  createCallbacks,
  createFailingSystemCommandChannel,
  createHangingSystemCommandChannel,
  createResolvedConfig,
  createSystemCommandChannel,
  createTarget
} from './ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import '../ssh-transport-selection'
import { resolveWithSshG } from '../config/ssh-g-config-resolution'
import { writeFileViaSystemSsh } from '../system-transport/system-ssh-file-transfer'
import { CONNECT_TIMEOUT_MS } from './ssh-connection-timing'
import { initSshHostKeyStoreFile, trustHostKey } from '../ssh-host-key-store'
import type { SshTarget } from '../../../shared/ssh-types'
import {
  createOpenSshPrivateKeyFixture,
  createOpenSshPublicKeyFixture
} from '../ssh-security-key-identity.test-fixture'

vi.mock('../ssh2-module-load', async () =>
  (await import('../__tests__/ssh-connection-test-client')).createSsh2LoaderModule()
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

  it.each([
    'Handshake failed: no matching host key format',
    'Handshake failed: no matching key exchange algorithm',
    'Handshake failed: no matching C->S cipher'
  ])(
    'falls back to system SSH when ssh2 shares no algorithm with the host (%s)',
    async (message) => {
      ssh2Mock.connectBehavior = 'error'
      ssh2Mock.connectErrorMessage = message
      const conn = new SshConnection(
        createTarget({ host: 'cert.example.com', label: 'Cert host' }),
        createCallbacks()
      )

      await conn.connect()

      expect(conn.getState().status).toBe('connected')
      expect(conn.usesSystemSshTransport()).toBe(true)
    }
  )

  it('keeps a host pinned in the Orca key store on ssh2 when negotiation fails', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'orca-ssh-pinned-store-'))
    try {
      initSshHostKeyStoreFile(join(storeDir, 'orca.json'))
      await trustHostKey({
        host: 'cert.example.com',
        port: 22,
        keyType: 'ssh-ed25519',
        key: Buffer.from(
          'AAAAC3NzaC1lZDI1NTE5AAAAIKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
          'base64'
        )
      })
      ssh2Mock.connectBehavior = 'error'
      ssh2Mock.connectErrorMessage = 'Handshake failed: no matching host key format'
      const conn = new SshConnection(
        createTarget({ host: 'cert.example.com', label: 'Cert host' }),
        createCallbacks()
      )

      await expect(conn.connect()).rejects.toThrow('no matching host key format')
      expect(spawnSystemSshCommandMock).not.toHaveBeenCalled()
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
    }
  })
})
