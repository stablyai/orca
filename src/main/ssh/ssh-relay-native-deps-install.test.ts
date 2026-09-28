// Deployment keeps terminal service available when the optional watcher cannot install.

import type * as RelayRipgrepInstallModule from './ssh-relay-ripgrep-install'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RelayInstallMarkerModule from './ssh-relay-install-marker'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+testhash')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    'sshChannelCloseConfirmed' in error &&
    error.sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-relay-bun-runtime', () => ({
  ensureRemoteRelayBunRuntime: vi.fn().mockResolvedValue('/managed/bun')
}))

vi.mock('./ssh-relay-install-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayInstallMarkerModule>()),
  createRelayInstallMarkerFileName: () => '.sftp-namespace-00000000000000000000000000000000'
}))

// Why: the post-launch ripgrep install would consume this file's queued exec mocks.
// Why: the post-launch ripgrep cache GC is fire-and-forget and would drain the queued exec mocks.
vi.mock('./ssh-relay-ripgrep-cache-gc', () => ({ gcRemoteRipgrepCache: vi.fn() }))
vi.mock('./ssh-relay-ripgrep-install', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayRipgrepInstallModule>()),
  ensureRemoteBundledRipgrep: vi.fn().mockResolvedValue('present'),
  recordRemoteRipgrepReference: vi.fn().mockResolvedValue(true)
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+testhash'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(false),
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

vi.mock('./ssh-relay-gc-claim', () => ({
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('launch-token'),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, waitForSentinel } from './ssh-relay-deploy-helpers'
import { RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
import {
  abandonInstall,
  finalizeInstall,
  isRelayAlreadyInstalled
} from './ssh-relay-versioned-install'
import { makeMockConnection, type SftpWriteCapture } from './ssh-relay-native-deps-install-fixture'

const MISSING = 'ORCA-NATIVE-DEPS-MISSING:@parcel/watcher'

describe('Bun watcher installation through relay deployment', () => {
  const capture: SftpWriteCapture = { paths: [], contents: {}, execCallCountAtWrite: {} }
  let installError: Error | undefined
  let probes: (string | Error)[]
  let socketProbes: number

  const commands = (): string[] => vi.mocked(execCommand).mock.calls.map(([, command]) => command)
  const installs = (): string[] =>
    commands().filter((command) => command.includes('install --ignore-scripts'))

  beforeEach(() => {
    vi.clearAllMocks()
    installError = undefined
    probes = []
    socketProbes = 0
    capture.paths.length = 0
    capture.contents = {}
    capture.execCallCountAtWrite = {}
    vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(false)
    vi.mocked(acquireInstallLock).mockReset().mockResolvedValue(undefined)
    vi.mocked(tryAcquireRelayRepairLock).mockReset().mockResolvedValue('acquired')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(execCommand)
      .mockReset()
      .mockImplementation(async (_conn, command) => {
        if (command.includes('uname')) {
          return '__ORCA_REMOTE_PLATFORM__ Linux x86_64'
        }
        if (command === 'echo $HOME') {
          return '/home/u'
        }
        const marker = command.match(/\.sftp-namespace-[0-9a-f]{32}/u)?.[0]
        if (command.includes('__ORCA_UPLOAD_STAGE_SLOT__')) {
          return `__ORCA_UPLOAD_STAGE_SLOT__${marker}:slot-0`
        }
        if (command.includes('__ORCA_UPLOAD_STAGE_PROMOTION__')) {
          return `__ORCA_UPLOAD_STAGE_PROMOTION__${marker}:PROMOTED`
        }
        if (command.includes('ORCA-NATIVE-DEPS-OK')) {
          const result = probes.shift() ?? 'ORCA-NATIVE-DEPS-OK'
          if (result instanceof Error) {
            throw result
          }
          return result
        }
        if (command.includes('install --ignore-scripts') && installError) {
          throw installError
        }
        if (command.includes('test -S')) {
          return socketProbes++ === 0 ? 'DEAD' : 'READY'
        }
        return ''
      })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('publishes the watcher-only manifest before invoking pinned Bun', async () => {
    const conn = makeMockConnection(capture)
    await deployAndLaunchRelay(conn)
    const path = capture.paths.find((path) => path.endsWith('/package.json'))
    expect(path).toBeDefined()
    if (!path) {
      throw new Error('Missing package manifest')
    }
    expect(JSON.parse(capture.contents[path])).toMatchObject({
      private: true,
      type: 'commonjs',
      dependencies: { '@parcel/watcher': '2.5.6' }
    })
    expect(JSON.parse(capture.contents[path]).dependencies).not.toHaveProperty('node-pty')
    expect(installs()).toHaveLength(1)
    expect(installs()[0]).toContain('/managed/bun')
    expect(capture.execCallCountAtWrite[path]).toBeLessThanOrEqual(
      commands().findIndex((command) => command.includes('install --ignore-scripts'))
    )
    expect(commands().some((command) => /npm |node-gyp|npm_config_nodedir/.test(command))).toBe(
      false
    )
    expect(finalizeInstall).toHaveBeenCalledWith(
      conn,
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ releaseLock: false })
    )
  })

  it('promotes only after locking, then installs into the owned final directory', async () => {
    let locked = false
    vi.mocked(acquireInstallLock).mockImplementationOnce(async () => {
      expect(
        commands().some((command) => command.includes('__ORCA_UPLOAD_STAGE_PROMOTION__'))
      ).toBe(false)
      locked = true
    })
    await deployAndLaunchRelay(makeMockConnection(capture))
    expect(locked).toBe(true)
    const promotion = commands().findIndex((command) =>
      command.includes('__ORCA_UPLOAD_STAGE_PROMOTION__')
    )
    expect(promotion).toBeGreaterThanOrEqual(0)
    expect(
      commands().findIndex((command) => command.includes('install --ignore-scripts'))
    ).toBeGreaterThan(promotion)
  })

  it('continues terminal startup after a confirmed optional watcher install failure', async () => {
    installError = new Error('registry unavailable')
    await expect(deployAndLaunchRelay(makeMockConnection(capture))).resolves.toBeDefined()
    expect(finalizeInstall).toHaveBeenCalledOnce()
    expect(waitForSentinel).toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Watcher installation failed'),
      installError
    )
  })

  it.each([false, true])(
    'retains ownership and stops after uncertain installation (repair: %s)',
    async (repair) => {
      vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(repair)
      probes = [MISSING, MISSING]
      installError = Object.assign(new Error('installer may still be running'), {
        sshChannelCloseConfirmed: false
      })
      const conn = makeMockConnection(capture)
      await expect(deployAndLaunchRelay(conn)).rejects.toBe(installError)
      expect(finalizeInstall).not.toHaveBeenCalled()
      expect(abandonInstall).not.toHaveBeenCalled()
      expect(waitForSentinel).not.toHaveBeenCalled()
      expect(conn.exec).not.toHaveBeenCalled()
    }
  )

  it('does not release the install lock when deadline cancellation leaves Bun running', async () => {
    vi.useFakeTimers()
    const respond = vi.mocked(execCommand).getMockImplementation()
    if (!respond) {
      throw new Error('Missing command responder')
    }
    vi.mocked(execCommand).mockImplementation((conn, command, options) => {
      if (!command.includes('install --ignore-scripts')) {
        return respond(conn, command, options)
      }
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener(
          'abort',
          () =>
            reject(
              Object.assign(new Error('Bun termination unconfirmed'), {
                sshChannelCloseConfirmed: false
              })
            ),
          { once: true }
        )
      })
    })
    const conn = makeMockConnection(capture)
    const pending = deployAndLaunchRelay(conn).catch((error: unknown) => error)
    await vi.waitFor(() => expect(installs()).toHaveLength(1))
    await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TIMEOUT_MS)
    expect(await pending).toBeInstanceOf(Error)
    expect(abandonInstall).not.toHaveBeenCalled()
    expect(finalizeInstall).not.toHaveBeenCalled()
    expect(waitForSentinel).not.toHaveBeenCalled()
  })

  it.each(['busy', 'error'] as const)(
    'does not mutate watcher files when repair lock is %s',
    async (lock) => {
      vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
      vi.mocked(tryAcquireRelayRepairLock).mockResolvedValue(lock)
      probes = [MISSING]
      await deployAndLaunchRelay(makeMockConnection(capture))
      expect(installs()).toHaveLength(0)
      expect(capture.paths.some((path) => path.endsWith('/package.json'))).toBe(false)
    }
  )

  it.each(['MISSING', 'ORCA-NATIVE-DEPS-OK', 'ORCA-NATIVE-DEPS-MISSING:node-pty'])(
    'does not repair without named watcher damage: %s',
    async (probe) => {
      vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
      probes = [probe]
      await deployAndLaunchRelay(makeMockConnection(capture))
      expect(installs()).toHaveLength(0)
      expect(finalizeInstall).not.toHaveBeenCalled()
    }
  )

  it('forces watcher replacement after both probes confirm damage', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    probes = [MISSING, MISSING]
    await deployAndLaunchRelay(makeMockConnection(capture))
    expect(installs()).toEqual([expect.stringContaining('--force')])
    expect(finalizeInstall).toHaveBeenCalledOnce()
  })

  it('retains the first confirmed repair scope when the locked probe cannot answer', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    probes = [MISSING, new Error('probe unavailable')]
    await deployAndLaunchRelay(makeMockConnection(capture))
    expect(installs()).toEqual([expect.stringContaining('--force')])
  })

  it('does not repair when the first probe cannot answer', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    probes = [new Error('probe unavailable')]
    await deployAndLaunchRelay(makeMockConnection(capture))
    expect(installs()).toHaveLength(0)
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Native deps probe unanswered')
    )
  })

  it('skips repair if the locked recheck finds a healthy watcher', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    probes = [MISSING, 'ORCA-NATIVE-DEPS-OK']
    await deployAndLaunchRelay(makeMockConnection(capture))
    expect(installs()).toHaveLength(0)
  })
})
