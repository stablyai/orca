import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  parseUnameToRelayPlatform: vi.fn(() => 'linux-x64'),
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

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
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
  shellEscape: (s: string) => `'${s}'`,
  createSshOperationAbortError: () =>
    Object.assign(new Error('SSH operation was cancelled'), { name: 'AbortError' })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { RelayCredentialMismatchError } from './ssh-relay-credential-mismatch-error'
import {
  isRelayEndpointHeldError,
  isRelayEndpointUnresponsiveError
} from './ssh-relay-endpoint-incumbent'
import type { SshConnection } from './ssh-connection'

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

// The daemon is present and its listener accepts (a SIGSTOPped relay still does — the kernel
// backlog answers), but nothing on the host can enumerate who holds the socket.
const LIVE_UNENUMERABLE_PROBE = [
  'ORCA-INCUMBENT-BEGIN',
  'PRESENT=yes',
  'LISTEN=accepted',
  'HOLDERS_SOURCE=unavailable',
  'ORCA-INCUMBENT-END'
].join('\n')

function queueAliveSocketThenProbe(): void {
  vi.mocked(execCommand)
    .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    .mockResolvedValueOnce('/home/user')
    .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    .mockResolvedValueOnce('') // launch namespace marker
    .mockResolvedValueOnce('ALIVE')
    .mockResolvedValueOnce(LIVE_UNENUMERABLE_PROBE)
}

function launchedDaemon(conn: SshConnection): boolean {
  return vi.mocked(conn.exec).mock.calls.some(([command]) => String(command).includes('--detached'))
}

/**
 * The `--connect` probe's catch block predates the incumbent probe and used to swallow every
 * error as "socket probe failed, launch fresh". With a live incumbent that is the collision the
 * probe exists to prevent: the fresh daemon loses the bind by luck, not by design.
 */
describe('deployAndLaunchRelay honours the incumbent verdict', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    vi.mocked(waitForSentinel).mockReset()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  it('does not launch over a live relay that never answered; the error is retryable', async () => {
    const conn = makeMockConnection()
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('Relay failed to start within 10s'))
    queueAliveSocketThenProbe()

    await expect(deployAndLaunchRelay(conn)).rejects.toSatisfy(isRelayEndpointUnresponsiveError)
    expect(launchedDaemon(conn)).toBe(false)
  })

  it('does not launch over a live relay that refused the credential; the error is terminal', async () => {
    const conn = makeMockConnection()
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new RelayCredentialMismatchError(''))
    queueAliveSocketThenProbe()

    await expect(deployAndLaunchRelay(conn)).rejects.toSatisfy(isRelayEndpointHeldError)
    expect(launchedDaemon(conn)).toBe(false)
  })

  it('still launches fresh when the socket probe itself fails', async () => {
    const conn = makeMockConnection()
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
      .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
      .mockResolvedValueOnce('') // launch namespace marker
      .mockRejectedValueOnce(new Error('test -S: transport hiccup'))
      .mockResolvedValueOnce('READY')
    vi.mocked(waitForSentinel).mockResolvedValueOnce({
      write: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn()
    })

    await deployAndLaunchRelay(conn)
    expect(launchedDaemon(conn)).toBe(true)
  })
})
