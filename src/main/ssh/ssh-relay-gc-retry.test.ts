import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => '/mock/app' } }))
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+gc-retry')
}))
vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn(),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  isUnconfirmedSshCommandTermination: () => false,
  execCommand: vi.fn()
}))
vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))
vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+gc-retry'),
  computeRemoteRelayDir: (home: string, version: string) => `${home}/.orca-remote/relay-${version}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(true),
  finalizeInstall: vi.fn(),
  abandonInstall: vi.fn(),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./ssh-relay-install-lock', () => ({ acquireInstallLock: vi.fn() }))
vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))
vi.mock('./ssh-relay-gc-claim', () => ({
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('launch-token'),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (value: string) => `'${value}'`,
  createSshOperationAbortError: () => Object.assign(new Error('cancelled'), { name: 'AbortError' })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import {
  releaseRelayGcClaimWithRetry,
  tryAcquireRelayGcClaim,
  waitForRelayGcClaimRelease
} from './ssh-relay-gc-claim'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
import { abandonInstall, isRelayAlreadyInstalled } from './ssh-relay-versioned-install'
import type { SshConnection } from './ssh-connection'

function makeConnection(): SshConnection {
  const channel = {
    on: vi.fn(),
    stderr: { on: vi.fn() },
    close: vi.fn()
  }
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    exec: vi.fn().mockResolvedValue(channel)
  } as unknown as SshConnection
}

describe('relay GC deploy retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('recomputes install state when GC wins before a healthy relay launch', async () => {
    const conn = makeConnection()
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValueOnce('gc')
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
        return '__ORCA_REMOTE_PLATFORM__ Linux x86_64'
      }
      if (command === 'echo $HOME') {
        return '/home/user'
      }
      if (command.includes('node-pty')) {
        return 'ORCA-NATIVE-DEPS-OK'
      }
      if (command.includes('var s=require("net").connect')) {
        return 'READY'
      }
      if (command.includes('test -S')) {
        return 'DEAD'
      }
      return ''
    })

    await deployAndLaunchRelay(conn)

    expect(waitForRelayGcClaimRelease).toHaveBeenCalledTimes(1)
    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(3)
    expect(conn.exec).toHaveBeenCalledTimes(2)
  })

  it('recomputes state when GC finishes between the install probe and lock acquisition', async () => {
    const conn = makeConnection()
    vi.mocked(isRelayAlreadyInstalled)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true)
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
        return '__ORCA_REMOTE_PLATFORM__ Linux x86_64'
      }
      if (command === 'echo $HOME') {
        return '/home/user'
      }
      if (command.includes('node-pty')) {
        return 'ORCA-NATIVE-DEPS-OK'
      }
      if (command.includes('var s=require("net").connect')) {
        return 'READY'
      }
      if (command.includes('test -S')) {
        return 'DEAD'
      }
      return ''
    })

    await deployAndLaunchRelay(conn)

    expect(abandonInstall).toHaveBeenCalledTimes(2)
    expect(waitForRelayGcClaimRelease).toHaveBeenCalledTimes(1)
    expect(isRelayAlreadyInstalled).toHaveBeenCalledTimes(4)
    expect(tryAcquireRelayRepairLock).toHaveBeenCalledTimes(2)
  })

  it('owns a GC claim through launch when the install-lock state is indeterminate', async () => {
    const conn = makeConnection()
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValueOnce('error')
    let resolveReady: ((value: Awaited<ReturnType<typeof waitForSentinel>>) => void) | undefined
    vi.mocked(waitForSentinel).mockImplementationOnce(
      async () =>
        new Promise<Awaited<ReturnType<typeof waitForSentinel>>>((resolve) => {
          resolveReady = resolve
        })
    )
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
        return '__ORCA_REMOTE_PLATFORM__ Linux x86_64'
      }
      if (command === 'echo $HOME') {
        return '/home/user'
      }
      if (command.includes('node-pty')) {
        return 'ORCA-NATIVE-DEPS-OK'
      }
      if (command.includes('var s=require("net").connect')) {
        return 'READY'
      }
      if (command.includes('test -S')) {
        return 'DEAD'
      }
      return ''
    })

    const deploy = deployAndLaunchRelay(conn)
    await vi.waitFor(() => expect(resolveReady).toBeDefined())
    expect(releaseRelayGcClaimWithRetry).not.toHaveBeenCalled()
    resolveReady?.({
      write: vi.fn(),
      onData: vi.fn(),
      onClose: vi.fn()
    })
    await deploy

    expect(waitForRelayGcClaimRelease).not.toHaveBeenCalled()
    expect(tryAcquireRelayRepairLock).toHaveBeenCalledTimes(1)
    expect(tryAcquireRelayGcClaim).toHaveBeenCalledTimes(1)
    expect(releaseRelayGcClaimWithRetry).toHaveBeenCalledTimes(1)
    expect(conn.exec).toHaveBeenCalledTimes(2)
  })

  it('retains an owned install lock when launch never becomes live', async () => {
    const conn = makeConnection()
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('launch failed'))
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
        return '__ORCA_REMOTE_PLATFORM__ Linux x86_64'
      }
      if (command === 'echo $HOME') {
        return '/home/user'
      }
      if (command.includes('node-pty')) {
        return 'ORCA-NATIVE-DEPS-OK'
      }
      if (command.includes('var s=require("net").connect')) {
        return 'READY'
      }
      if (command.includes('test -S')) {
        return 'DEAD'
      }
      return ''
    })

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow('launch failed')

    expect(abandonInstall).not.toHaveBeenCalled()
    expect(releaseRelayGcClaimWithRetry).not.toHaveBeenCalled()
  })

  it('retains an owned launch claim when launch never becomes live', async () => {
    const conn = makeConnection()
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValueOnce('busy')
    vi.mocked(waitForSentinel).mockRejectedValueOnce(new Error('launch failed'))
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
        return '__ORCA_REMOTE_PLATFORM__ Linux x86_64'
      }
      if (command === 'echo $HOME') {
        return '/home/user'
      }
      if (command.includes('node-pty')) {
        return 'ORCA-NATIVE-DEPS-OK'
      }
      if (command.includes('var s=require("net").connect')) {
        return 'READY'
      }
      if (command.includes('test -S')) {
        return 'DEAD'
      }
      return ''
    })

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow('launch failed')

    expect(abandonInstall).not.toHaveBeenCalled()
    expect(releaseRelayGcClaimWithRetry).not.toHaveBeenCalled()
  })

  it('keeps retrying repeated launch-claim contention within the deploy bound', async () => {
    const conn = makeConnection()
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValue('busy')
    vi.mocked(tryAcquireRelayGcClaim)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('launch-token')
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('__ORCA_REMOTE_PLATFORM__')) {
        return '__ORCA_REMOTE_PLATFORM__ Linux x86_64'
      }
      if (command === 'echo $HOME') {
        return '/home/user'
      }
      if (command.includes('node-pty')) {
        return 'ORCA-NATIVE-DEPS-OK'
      }
      if (command.includes('var s=require("net").connect')) {
        return 'READY'
      }
      if (command.includes('test -S')) {
        return 'DEAD'
      }
      return ''
    })

    await deployAndLaunchRelay(conn)

    expect(waitForRelayGcClaimRelease).toHaveBeenCalledTimes(2)
    expect(tryAcquireRelayGcClaim).toHaveBeenCalledTimes(3)
    expect(releaseRelayGcClaimWithRetry).toHaveBeenCalledTimes(1)
  })
})
