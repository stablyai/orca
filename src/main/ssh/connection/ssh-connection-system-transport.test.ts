import { describe, expect, it, vi, beforeEach } from 'vitest'
import type * as ChildProcessModule from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ssh2Mock } from './testing/ssh-connection-test-client'
import {
  findSystemSshMock,
  getOrcaControlSocketPathMock,
  removeControlSocketPathMock,
  resetSshConnectionMocks,
  spawnSystemSshCommandMock
} from './testing/ssh-connection-test-harness'
import {
  createCallbacks,
  createFailingSystemCommandChannel,
  createHangingSystemCommandChannel,
  createResolvedConfig,
  createSystemCommandChannel,
  createTarget
} from './testing/ssh-connection-test-fixtures'
import { SshConnection } from './ssh-connection'
import '../system-transport/ssh-transport-selection'
import { resolveWithSshG } from '../config/ssh-g-config-resolution'
import { writeFileViaSystemSsh } from '../system-transport/file-transfer/system-ssh-file-transfer'
import { CONNECT_TIMEOUT_MS } from './ssh-connection-timing'
import { initSshHostKeyStoreFile, trustHostKey } from '../host-keys/ssh-host-key-store'
import type { SshTarget } from '../../../shared/remote-runtime/ssh/ssh-types'
import type * as SystemSshCommand from '../system-transport/system-ssh-command'

const { spawnMock, actualSystemSshCommand } = vi.hoisted(() => {
  const actual: { module?: typeof SystemSshCommand } = {}
  return { spawnMock: vi.fn(), actualSystemSshCommand: actual }
})
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: spawnMock
}))

function fakeSshProcessExitingOnStdinEnd(stdout: string) {
  const proc = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  spawnMock.mockReturnValue(proc)
  proc.stdin.resume()
  // Like a real child, close only after its stdout has drained.
  proc.stdout.once('end', () => proc.emit('close', 0))
  proc.stdin.on('finish', () => proc.stdout.end(stdout))
  return proc
}

vi.mock('../authentication/ssh2-module-load', async () =>
  (await import('./testing/ssh-connection-test-client')).createSsh2LoaderModule()
)
vi.mock('../system-transport/system-ssh-binary', async () =>
  (await import('./testing/ssh-connection-test-harness')).createSystemSshBinaryModule()
)
vi.mock('../system-transport/system-ssh-args', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSystemSshArgsMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/system-ssh-command', async (importOriginal) => {
  actualSystemSshCommand.module = await importOriginal<typeof SystemSshCommand>()
  return (await import('./testing/ssh-connection-test-harness')).withSystemSshCommandMocks(
    actualSystemSshCommand.module
  )
})
vi.mock(
  '../system-transport/file-transfer/system-ssh-file-binary-transfer',
  async (importOriginal) =>
    (await import('./testing/ssh-connection-test-harness')).withSystemSshFileBinaryTransferMocks(
      await importOriginal()
    )
)
vi.mock('../system-transport/file-transfer/system-ssh-file-transfer', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSystemSshFileTransferMocks(
    await importOriginal()
  )
)
vi.mock('../system-transport/ssh-control-socket', async () =>
  (await import('./testing/ssh-connection-test-harness')).createControlSocketModule()
)
vi.mock('../config/ssh-config-parser', async () =>
  (await import('./testing/ssh-connection-test-harness')).createSshConfigParserModule()
)
vi.mock('../config/ssh-g-config-resolution', async (importOriginal) =>
  (await import('./testing/ssh-connection-test-harness')).withSshGConfigResolutionMocks(
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

  it('ends the ssh child input for a command that sends none', async () => {
    findSystemSshMock.mockReturnValue('/usr/bin/ssh')
    vi.mocked(resolveWithSshG).mockResolvedValueOnce(createResolvedConfig())
    const conn = new SshConnection(
      createTarget({ configHost: 'fdpass-host', systemSshConnectionReuse: false }),
      createCallbacks()
    )
    await conn.connect()
    const actual = actualSystemSshCommand.module
    if (!actual) {
      throw new Error('system-ssh-command mock factory did not run')
    }
    spawnSystemSshCommandMock.mockImplementation(actual.spawnSystemSshCommand)
    const proc = fakeSshProcessExitingOnStdinEnd('answer')

    const channel = await conn.execWithClosedStdin('probe')
    const stdout = await new Promise<string>((resolve) => {
      let received = ''
      channel.on('data', (data: Buffer) => {
        received += data.toString()
      })
      channel.once('close', () => resolve(received))
    })

    expect(stdout).toBe('answer')
    expect(proc.stdin.writableFinished).toBe(true)
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
