import { beforeEach, describe, expect, it, vi } from 'vitest'
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

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { parseUnameToRelayPlatform } from './relay-protocol'
import {
  makeExecResponses,
  makeStagedFirstInstallExecPrefix,
  makeMockConnection,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'
import { RELAY_NATIVE_CACHE_LINKED } from './ssh-relay-native-deps-cache-commands'
import { RELAY_ARTIFACTS } from '../../shared/relay-artifacts'
import {
  computeRelayNativeDepsCacheKey,
  RELAY_NATIVE_DEPS_PATCH_ARTIFACT_PATTERN
} from './ssh-relay-native-deps-cache'

const PATCH_ASSET = 'node-pty-1.1.0-master-cloexec-patch.cjs'

/**
 * The relay installs stock node-pty from npm, so the app's pnpm patch never reaches it and every
 * later child of the relay inherits a live pty master (#17915). The compile that closes it sits on
 * the connect path, so what these specs pin is the blast radius, not the patch itself.
 */
describe('relay pty-master close-on-exec patch on the install path', () => {
  const sftpCapture: SftpWriteCapture = {
    paths: [],
    contents: {},
    execCallCountAtWrite: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    sftpCapture.paths.length = 0
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
  })

  function feed(execResponses: ExecResponse[]): void {
    const mockExec = vi.mocked(execCommand)
    for (const response of execResponses) {
      if (typeof response === 'string') {
        mockExec.mockResolvedValueOnce(response)
      } else {
        mockExec.mockRejectedValueOnce(new Error(response.reject))
      }
    }
  }

  function firstInstall(cacheAnswer: string, tail: ExecResponse[]): ExecResponse[] {
    const prefix = makeStagedFirstInstallExecPrefix()
    // The prefix's last slot is the shared native-deps cache probe.
    prefix[prefix.length - 1] = cacheAnswer
    return [...prefix, ...tail]
  }

  function patchCommands(): string[] {
    return vi
      .mocked(execCommand)
      .mock.calls.map(([, command]) => command)
      .filter((command) => command.includes(PATCH_ASSET))
  }

  /** Whether this deploy elected itself publisher of the shared entry. */
  function promoted(): boolean {
    return vi
      .mocked(execCommand)
      .mock.calls.some(([, command]) => command.includes('mkdir "$cache"'))
  }

  /**
   * A cache-miss first install whose patch reports `status`. The promote slot is fed either way,
   * so a run that wrongly promotes reads a valid response rather than falling off the end -- the
   * assertion has to be the absence of the command itself, not a downstream crash.
   */
  function firstInstallReporting(status: string): ExecResponse[] {
    return [
      ...makeStagedFirstInstallExecPrefix(),
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      `ORCA-NPTY-CLOEXEC:${status}\n`,
      '', // promote into the shared native-deps cache, if this deploy still gets that far
      '', // clean stage root
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ]
  }

  it('runs the patch on a Linux relay once node-pty is proven loadable', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'ok' }))

    await deployAndLaunchRelay(conn)

    expect(patchCommands()).toHaveLength(1)
    expect(patchCommands()[0]).toContain("'/usr/bin/node'")
  })

  it('patches the private tree before it is published to the shared native-deps cache', async () => {
    // Promotion moves `node_modules` into `~/.orca-remote/native/<key>` and leaves a symlink
    // behind, and a published entry is immutable by contract. Patching afterwards would rename,
    // rebuild and roll back inside a tree every other relay on the host links -- and the
    // `.deps-complete` written by promotion would have published an unpatched tree that every
    // later host links and skips. The ordering is invisible in review, so pin it.
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'ok' }))

    await deployAndLaunchRelay(conn)

    const commands = vi.mocked(execCommand).mock.calls.map(([, command]) => command)
    const patchAt = commands.findIndex((command) => command.includes(PATCH_ASSET))
    const promoteAt = commands.findIndex((command) => command.includes('mkdir "$cache"'))
    expect(patchAt).toBeGreaterThan(-1)
    expect(promoteAt).toBeGreaterThan(-1)
    expect(patchAt).toBeLessThan(promoteAt)
  })

  it('does not publish a tree whose patch failed and rolled back', async () => {
    // The script rolls `pty.cc` and `build/Release` back to the pre-patch, still-leaky build and
    // reports `failed:` with exit 0, so nothing throws. Publishing that tree would be worse than
    // the leak this PR closes: the key hashes the patch's bytes, so every later host on the
    // machine links the entry, probes it loadable, and skips patching. Stay private instead.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const conn = makeMockConnection(sftpCapture)
      feed(firstInstallReporting('failed:npm rebuild node-pty failed: gyp ERR! not found: make'))

      await deployAndLaunchRelay(conn)

      expect(patchCommands()).toHaveLength(1)
      expect(promoted()).toBe(false)
      expect(warn.mock.calls.map((args) => String(args[0] ?? '')).join('\n')).toContain(
        '[ssh-relay][NPTY-CLOEXEC-UNSHARED]'
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('does not publish a tree the patch refused to touch', async () => {
    // `skipped:` is not one verdict. Every form except `skipped:not-linux` means the patch was
    // declined and the leaky build is still on disk, which is indistinguishable from `failed:`
    // as far as what would get published.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const conn = makeMockConnection(sftpCapture)
      feed(firstInstallReporting('skipped:earlier-attempt-failed'))

      await deployAndLaunchRelay(conn)

      expect(promoted()).toBe(false)
      // A refusal exits 0, so the warn is the only signal that this host stayed leaky.
      expect(warn.mock.calls.map((args) => String(args[0] ?? '')).join('\n')).toContain(
        '[ssh-relay][NPTY-CLOEXEC-UNFIXED]'
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('still publishes a tree that was patched but whose isolation check could not run', async () => {
    // `patched-unverified` rebuilt from patched source; only the check that watches a later child
    // could not observe the result. An unobservable check is not a failed patch, and refusing to
    // publish here would disable the shared cache on every host without `lsof`.
    const conn = makeMockConnection(sftpCapture)
    feed(firstInstallReporting('patched-unverified'))

    await deployAndLaunchRelay(conn)

    expect(promoted()).toBe(true)
  })

  it('never patches through a symlink into an entry another relay already published', async () => {
    // A linked entry was built under a key that hashes this patch's bytes, so it is already
    // patched; re-running the patch would rebuild inside the shared tree.
    const conn = makeMockConnection(sftpCapture)
    feed(
      firstInstall(RELAY_NATIVE_CACHE_LINKED, [
        '', // chmod prebuilds, through the symlink
        'ORCA-NPTY-PROBE-OK\n',
        '', // rm probe stderr
        '', // clean stage root
        'DEAD',
        '', // publish the per-launch credential
        'READY'
      ])
    )

    await deployAndLaunchRelay(conn)

    expect(patchCommands()).toEqual([])
  })

  it('leaves an unloadable node-pty alone rather than rebuilding it blind', async () => {
    // A relay that could not build node-pty has nothing to fall back to, and the existing
    // reinstall path owns that repair.
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: 'ok',
        probe: 'missing',
        repairProbe: 'missing'
      })
    )

    await deployAndLaunchRelay(conn)

    expect(patchCommands()).toEqual([])
  })

  it('never adds a compile to a macOS relay, which does not leak the master', async () => {
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('darwin-arm64')
    const conn = makeMockConnection(sftpCapture)
    feed([
      ...makeStagedFirstInstallExecPrefix(),
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      '', // promote into the shared native-deps cache
      '', // clean stage root
      'DEAD',
      '', // publish the per-launch credential
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    expect(patchCommands()).toEqual([])
  })

  it('connects anyway when the patch command fails outright', async () => {
    const conn = makeMockConnection(sftpCapture)
    const responses = makeExecResponses({ npmInstall: 'ok', probe: 'ok' })
    const patchSlot = responses.findIndex(
      (response) => typeof response === 'string' && response.includes('ORCA-NPTY-CLOEXEC:')
    )
    expect(patchSlot).toBeGreaterThan(-1)
    responses[patchSlot] = { reject: 'no such file or directory' }
    feed(responses)

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()
  })
})

describe('the shipped patch is part of the shared native-deps cache key', () => {
  it('mints a new entry, so a pre-fix unpatched tree is never linked by a patched build', () => {
    const artifact = RELAY_ARTIFACTS.find((entry) => entry.filename === PATCH_ASSET)
    expect(artifact).toBeDefined()
    // A windowsOnly artifact never reaches a Linux relay dir, so it would drop out of the key.
    expect(artifact?.windowsOnly).toBeFalsy()
    expect(RELAY_NATIVE_DEPS_PATCH_ARTIFACT_PATTERN.test(PATCH_ASSET)).toBe(true)

    const deps = { 'node-pty': '1.1.0' }
    expect(
      computeRelayNativeDepsCacheKey({
        platform: 'linux-x64',
        deps,
        patchSources: [{ filename: PATCH_ASSET, contents: 'patch bytes' }]
      })
    ).not.toBe(computeRelayNativeDepsCacheKey({ platform: 'linux-x64', deps }))
  })
})
