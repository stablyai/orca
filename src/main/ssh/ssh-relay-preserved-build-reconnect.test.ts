import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn((os: string, arch: string) => {
    const relayArch = ['arm64', 'aarch64'].includes(arch.toLowerCase()) ? 'arm64' : 'x64'
    return os.toLowerCase() === 'windows' ? `win32-${relayArch}` : `linux-${relayArch}`
  }),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-endpoint-credential', () => ({
  writeRelayEndpointCredential: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345'),
  computeRemoteRelayDir: (home: string, version: string) => `${home}/.orca-remote/relay-${version}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (value: string) => `'${value}'`,
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), { name: 'AbortError' })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import { isRelayAlreadyInstalled } from './ssh-relay-versioned-install'

function makeMockConnection(): SshConnection {
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    writeFile: vi.fn().mockResolvedValue(undefined)
  } as unknown as SshConnection
}

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)?.[1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('preserved relay build reconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    vi.mocked(waitForSentinel)
      .mockReset()
      .mockResolvedValue({ write: vi.fn(), onData: vi.fn(), onClose: vi.fn() })
    vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(true)
    vi.mocked(resolveRemoteNodePath).mockReset().mockResolvedValue('/usr/bin/node')
  })

  it('reconnects the persisted relay before deploying a new content hash', async () => {
    const conn = makeMockConnection()
    const previousBuildId = '0.1.0+111111111111'
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
      .mockResolvedValueOnce('ALIVE')

    const result = await deployAndLaunchRelay(
      conn,
      undefined,
      undefined,
      'target-a',
      previousBuildId
    )

    expect(result.serverBuildId).toBe(previousBuildId)
    expect(result.remoteRelayDir).toBe(`/home/user/.orca-remote/relay-${previousBuildId}`)
    const commands = vi.mocked(conn.exec).mock.calls.map(([command]) => command as string)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain(`/relay-${previousBuildId}`)
    expect(commands[0]).toContain('relay.js --connect')
    expect(commands[0]).not.toContain('--detached')
  })

  it('falls back without unlinking the preserved relay socket', async () => {
    const conn = makeMockConnection()
    const previousBuildId = '0.1.0+111111111111'
    vi.mocked(waitForSentinel)
      .mockRejectedValueOnce(new Error('preserved relay unavailable'))
      .mockResolvedValueOnce({ write: vi.fn(), onData: vi.fn(), onClose: vi.fn() })
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
      .mockResolvedValueOnce('ALIVE')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('READY')

    const result = await deployAndLaunchRelay(
      conn,
      undefined,
      undefined,
      'target-a',
      previousBuildId
    )

    expect(result.serverBuildId).toBe('0.1.0+abcdef012345')
    const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    expect(
      commands.some(
        (command) => command.includes('rm -f') && command.includes(`/relay-${previousBuildId}/`)
      )
    ).toBe(false)
  })

  it('does not reconnect a build from another relay protocol version', async () => {
    const conn = makeMockConnection()
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('READY')

    const result = await deployAndLaunchRelay(
      conn,
      undefined,
      undefined,
      'target-a',
      '0.2.0+111111111111'
    )

    expect(result.serverBuildId).toBe('0.1.0+abcdef012345')
    const commands = [
      ...vi.mocked(execCommand).mock.calls.map(([, command]) => command),
      ...vi.mocked(conn.exec).mock.calls.map(([command]) => command as string)
    ]
    expect(commands.some((command) => command.includes('0.2.0+111111111111'))).toBe(false)
  })

  it('reconnects the persisted build through its Windows active pipe', async () => {
    const conn = makeMockConnection()
    const previousBuildId = '0.1.0+111111111111'
    const persistedPipe = '\\\\.\\pipe\\orca-relay-1234567890abcdef1234'
    vi.mocked(resolveRemoteNodePath).mockResolvedValue('C:/Program Files/nodejs/node.exe')
    vi.mocked(execCommand)
      .mockRejectedValueOnce(new Error('uname not found'))
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64')
      .mockResolvedValueOnce('C:\\Users\\me')
      .mockResolvedValueOnce(persistedPipe)
      .mockResolvedValueOnce('READY')

    const result = await deployAndLaunchRelay(
      conn,
      undefined,
      undefined,
      'target-a',
      previousBuildId
    )

    expect(result.serverBuildId).toBe(previousBuildId)
    expect(result.sockPath).toBe(persistedPipe)
    const commands = vi
      .mocked(conn.exec)
      .mock.calls.map(([command]) => decodePowerShellCommand(command as string))
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain(`relay-${previousBuildId}`)
    expect(commands[0]).toContain('relay.js --connect')
    expect(commands[0]).not.toContain('Invoke-CimMethod')
  })
})
