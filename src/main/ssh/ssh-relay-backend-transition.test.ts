import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/mock/app' } }))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000,
  parseUnameToRelayPlatform: vi.fn(() => 'linux-x64')
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: vi.fn().mockReturnValue(false),
  waitForSentinel: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-endpoint-credential', () => ({
  writeRelayEndpointCredential: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  computeRemoteRelayDir: (home: string, version: string) => `${home}/.orca-remote/relay-${version}`,
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined),
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-relay-gc-claim', () => ({
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('gc-claim-token'),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  createSshOperationAbortError: () => Object.assign(new Error('cancelled'), { name: 'AbortError' }),
  shellEscape: (value: string) => `'${value}'`
}))

import type { SshConnection } from './ssh-connection'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { releaseRelayGcClaimWithRetry, tryAcquireRelayGcClaim } from './ssh-relay-gc-claim'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
import { abandonInstall } from './ssh-relay-versioned-install'

function makeConnection(): SshConnection {
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    exec: vi.fn(),
    sftp: vi.fn().mockResolvedValue({
      mkdir: vi.fn((_path: string, callback: (error: Error | null) => void) => callback(null)),
      end: vi.fn()
    }),
    writeFile: vi.fn().mockResolvedValue(undefined)
  } as unknown as SshConnection
}

function queueBootstrap(socketProbe: string, includesLaunchNamespace: boolean): void {
  vi.mocked(execCommand)
    .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    .mockResolvedValueOnce('/home/user')
    .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
  if (includesLaunchNamespace) {
    vi.mocked(execCommand).mockResolvedValueOnce('')
  }
  vi.mocked(execCommand).mockResolvedValueOnce(socketProbe)
}

describe('relay PTY backend transition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(tryAcquireRelayRepairLock).mockReset().mockResolvedValue('acquired')
    vi.mocked(tryAcquireRelayGcClaim).mockReset().mockResolvedValue('gc-claim-token')
    vi.mocked(releaseRelayGcClaimWithRetry).mockReset().mockResolvedValue('released')
  })

  it('releases an acquired install lock after a backend mismatch', async () => {
    const connection = makeConnection()
    queueBootstrap('ALIVE:relay', true)

    await expect(deployAndLaunchRelay(connection, undefined, 0, 'target-a', 'zmx')).rejects.toThrow(
      'Reset Relay to apply zmx'
    )

    expect(abandonInstall).toHaveBeenCalledTimes(1)
  })

  it('fences a relay-backed launch over a dead relay whose marker says zmx', async () => {
    const connection = makeConnection()
    queueBootstrap('DEAD:zmx', true)

    await expect(
      deployAndLaunchRelay(connection, undefined, 0, 'target-a', 'relay')
    ).rejects.toThrow('durable zmx terminals from a previous session')

    expect(abandonInstall).toHaveBeenCalledTimes(1)
  })

  it('keeps the install lock on an ordinary launch failure', async () => {
    const connection = makeConnection()
    queueBootstrap('DEAD', true)
    vi.mocked(execCommand).mockRejectedValueOnce(new Error('launch exploded'))

    await expect(
      deployAndLaunchRelay(connection, undefined, 0, 'target-a', 'relay')
    ).rejects.toThrow()

    // Why: the detached start may still be running; only pre-launch
    // deterministic rejections may release the fences.
    expect(abandonInstall).not.toHaveBeenCalled()
  })

  it('releases an acquired GC claim after a backend mismatch', async () => {
    const connection = makeConnection()
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValueOnce('busy')
    queueBootstrap('ALIVE:relay', false)

    await expect(deployAndLaunchRelay(connection, undefined, 0, 'target-a', 'zmx')).rejects.toThrow(
      'Reset Relay to apply zmx'
    )

    expect(releaseRelayGcClaimWithRetry).toHaveBeenCalledWith(
      connection,
      '/home/user/.orca-remote/relay-0.1.0+abcdef012345',
      'gc-claim-token',
      expect.objectContaining({ relayPlatform: 'linux-x64' })
    )
  })
})
