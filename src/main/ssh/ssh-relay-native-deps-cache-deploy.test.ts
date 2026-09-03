// The claim this file has to hold up: a second deploy of a *different bundle* to the same host
// runs no `npm install` at all. Everything else here is the fallback ladder underneath it — a
// host that cannot link, cannot publish, or answers nothing still deploys exactly as before.

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
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-install-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayInstallMarkerModule>()),
  createRelayInstallMarkerFileName: () => '.sftp-namespace-00000000000000000000000000000000'
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

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, uploadDirectory } from './ssh-relay-deploy-helpers'
import { parseUnameToRelayPlatform } from './relay-protocol'
import { isRelayAlreadyInstalled, gcOldRelayVersions } from './ssh-relay-versioned-install'
import {
  makeMockConnection,
  makeStagedFirstInstallExecPrefix,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'
import {
  RELAY_NATIVE_CACHE_LINKED,
  RELAY_NATIVE_CACHE_MISS,
  RELAY_NATIVE_CACHE_PROMOTED
} from './ssh-relay-native-deps-cache-commands'

// Everything after the probe on a healthy install: stderr cleanup, stage cleanup, launch.
// Stdout of the relay-side pty-master cloexec patch, which runs on Linux hosts once a
// freshly installed node-pty loads (#17915).
const NPTY_CLOEXEC_PATCHED = 'ORCA-NPTY-CLOEXEC:patched\n'
const LAUNCH_TAIL: ExecResponse[] = ['', 'DEAD', '', 'READY']

describe('relay native-deps cache on the deploy path', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const sftpCapture: SftpWriteCapture = { paths: [], contents: {}, execCallCountAtWrite: {} }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    vi.mocked(uploadDirectory).mockResolvedValue(undefined)
    sftpCapture.paths.length = 0
    for (const k of Object.keys(sftpCapture.contents)) {
      delete sftpCapture.contents[k]
    }
    for (const k of Object.keys(sftpCapture.execCallCountAtWrite)) {
      delete sftpCapture.execCallCountAtWrite[k]
    }
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(false)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  function feed(responses: ExecResponse[]): void {
    const mockExec = vi.mocked(execCommand)
    for (const r of responses) {
      if (typeof r === 'string') {
        mockExec.mockResolvedValueOnce(r)
      } else {
        mockExec.mockRejectedValueOnce(new Error(r.reject))
      }
    }
  }

  function execCommands(): string[] {
    return vi.mocked(execCommand).mock.calls.map(([, command]) => command)
  }

  /**
   * A first install whose cache probe answers `cacheAnswer`. The prefix's last slot is the cache
   * probe, so overriding it is the only difference between a hit and a miss.
   */
  function firstInstall(cacheAnswer: string, tail: ExecResponse[]): ExecResponse[] {
    const prefix = makeStagedFirstInstallExecPrefix()
    prefix[prefix.length - 1] = cacheAnswer
    return [...prefix, ...tail]
  }

  it('runs no npm install when a different bundle finds a complete entry on the host', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      firstInstall(RELAY_NATIVE_CACHE_LINKED, [
        '', // chmod prebuilds, through the symlink
        'ORCA-NPTY-PROBE-OK\n',
        '', // rm probe stderr
        ...LAUNCH_TAIL
      ])
    )

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    const commands = execCommands()
    expect(commands.some((c) => c.includes('npm install'))).toBe(false)
    expect(commands.some((c) => c.includes('npm rebuild'))).toBe(false)
    // The bundle still gets its own directory; only the native tree is shared.
    expect(commands.some((c) => c.includes('.orca-remote/relay-0.1.0+testhash'))).toBe(true)
    expect(commands.some((c) => /\.orca-remote\/native\/linux-x64-[0-9a-f]{16}/.test(c))).toBe(true)
  })

  it('still installs on the first deploy, then publishes the tree the probe loaded', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      firstInstall(RELAY_NATIVE_CACHE_MISS, [
        '', // npm install
        '', // chmod prebuilds
        'ORCA-NPTY-PROBE-OK\n',
        '', // rm probe stderr
        NPTY_CLOEXEC_PATCHED,
        RELAY_NATIVE_CACHE_PROMOTED,
        ...LAUNCH_TAIL
      ])
    )

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    const commands = execCommands()
    const install = commands.find((c) => c.includes('npm install')) ?? ''
    expect(install).toContain('node-pty@1.1.0')
    // The install runs in the relay directory; publication moves the finished tree afterwards.
    expect(install).toContain('.orca-remote/relay-0.1.0+testhash')
    const promote = commands.findLast((c) => c.includes('mkdir "$cache"')) ?? ''
    expect(promote).toContain(': > "$cache/.deps-complete"')
  })

  it('does not publish a tree the probe could not load', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      firstInstall(RELAY_NATIVE_CACHE_MISS, [
        '', // npm install
        '', // chmod prebuilds
        'MISSING\n',
        '', // cat probe stderr
        '', // rm probe stderr
        '', // npm rebuild
        '', // chmod prebuilds after rebuild
        'MISSING\n',
        '', // cat stderr after rebuild
        '', // rm stderr after rebuild
        ...LAUNCH_TAIL
      ])
    )

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    expect(execCommands().some((c) => c.includes('mkdir "$cache"'))).toBe(false)
  })

  it('installs per-directory when the host cannot answer the cache probe at all', async () => {
    const conn = makeMockConnection(sftpCapture)
    const prefix = makeStagedFirstInstallExecPrefix()
    prefix[prefix.length - 1] = { reject: 'mkdir: Read-only file system' }
    feed([
      ...prefix,
      '', // npm install still runs
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      NPTY_CLOEXEC_PATCHED,
      '', // publication is attempted and answers nothing
      ...LAUNCH_TAIL
    ])

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    expect(execCommands().some((c) => c.includes('npm install'))).toBe(true)
  })

  it('falls back to its own install when a linked entry does not load on this host', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      firstInstall(RELAY_NATIVE_CACHE_LINKED, [
        '', // chmod prebuilds
        'MISSING\n', // the shared tree does not load here
        '', // cat probe stderr
        '', // rm probe stderr
        '', // npm install, privately, after the prefix detaches the symlink
        '', // chmod prebuilds
        'ORCA-NPTY-PROBE-OK\n',
        '', // rm probe stderr
        NPTY_CLOEXEC_PATCHED,
        '', // promotion attempt (the entry already exists, so it is declined)
        ...LAUNCH_TAIL
      ])
    )

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    const install = execCommands().find((c) => c.includes('npm install')) ?? ''
    // Why this prefix is the whole point: npm follows the symlink, and every other relay on the
    // host is running out of the tree on the other side of it.
    expect(install).toContain('if [ -L node_modules ]; then rm -f node_modules; fi;')
    const warnings = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnings.some((m) => m.includes('[ssh-relay][NATIVE-CACHE-UNUSABLE]'))).toBe(true)
  })

  it('detaches rather than resetting through the link when repairing an installed relay', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    const bothMissing = 'ORCA-NATIVE-DEPS-MISSING:node-pty,@parcel/watcher\nMISSING'
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      bothMissing, // health probe before the repair lock
      bothMissing, // re-probe under the lock
      '', // install-owner marker
      '', // npm install
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      NPTY_CLOEXEC_PATCHED,
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()

    const commands = execCommands()
    // A repair never consults the shared entry: its reset would rewrite a tree it does not own.
    expect(commands.some((c) => c.includes('.orca-remote/native/'))).toBe(false)
    const install = commands.find((c) => c.includes('npm install')) ?? ''
    expect(install).toContain('if [ -L node_modules ]; then rm -f node_modules; fi;')
    expect(install).toContain("rm -rf 'node_modules/node-pty'")
  })

  it('pins its own key so a GC pass cannot collect the entry this connection depends on', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      firstInstall(RELAY_NATIVE_CACHE_LINKED, [
        '', // chmod prebuilds
        'ORCA-NPTY-PROBE-OK\n',
        '', // rm probe stderr
        ...LAUNCH_TAIL
      ])
    )

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()
    await vi.waitFor(() => expect(vi.mocked(gcOldRelayVersions)).toHaveBeenCalled())

    const options = vi.mocked(gcOldRelayVersions).mock.calls.at(-1)?.[4]
    expect(options?.nativeDepsCacheKeys).toEqual([
      expect.stringMatching(/^linux-x64-[0-9a-f]{16}$/)
    ])
  })
})
