import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RelayRipgrepInstallModule from './ssh-relay-ripgrep-install'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

// Why: deployAndLaunchRelay now reads `${localRelayDir}/.version` upfront
// (per docs/ssh-relay-versioned-install-dirs.md). The fs mock must report
// the local relay package as existing AND return a content-hashed version
// string so readLocalFullVersion succeeds.
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+abcdef012345')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn((os: string, arch: string) => {
    const normalizedOs = os.toLowerCase()
    const normalizedArch = arch.toLowerCase()
    const relayArch = normalizedArch === 'arm64' || normalizedArch === 'aarch64' ? 'arm64' : 'x64'
    if (normalizedOs === 'windows' || normalizedOs === 'win32') {
      return `win32-${relayArch}`
    }
    if (normalizedOs === 'darwin') {
      return `darwin-${relayArch}`
    }
    if (normalizedOs === 'linux') {
      return `linux-${relayArch}`
    }
    return null
  }),
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
  execCommand: vi.fn().mockResolvedValue('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

// Why: this file mocks fs, so the real content hash cannot read a binary.
vi.mock('../ripgrep/bundled-ripgrep-path', () => ({
  resolveBundledRipgrepPath: () => null,
  bundledRipgrepContentKey: () => 'c0ffee0123456789'
}))

// Why: the fire-and-forget ripgrep install would drain the queued exec mocks.
// Why: the post-launch ripgrep cache GC is fire-and-forget and would drain the queued exec mocks.
vi.mock('./ssh-relay-ripgrep-cache-gc', () => ({ gcRemoteRipgrepCache: vi.fn() }))
vi.mock('./ssh-relay-opencode-runtime', () => ({
  ensureRemoteOpenCodeRuntime: vi.fn().mockResolvedValue('ready')
}))
vi.mock('./ssh-relay-ripgrep-install', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayRipgrepInstallModule>()),
  ensureRemoteBundledRipgrep: vi.fn().mockResolvedValue('present'),
  recordRemoteRipgrepReference: vi.fn().mockResolvedValue(true)
}))

// Why: the versioned-install modules shell out for install state, locking,
// and GC. Stub them so deploy tests need no real SSH connection.
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
    Object.assign(new Error('SSH operation was cancelled'), {
      name: 'AbortError'
    })
}))

vi.mock('./ssh-relay-pinned-node', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planPinnedNodeRelay: vi.fn(),
  resolvePinnedRelayTargetFacts: vi.fn()
}))

vi.mock('./ssh-relay-pinned-node-install', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensurePinnedRelayRuntime: vi.fn().mockResolvedValue(undefined),
  verifyPinnedRelayInstall: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-host-node-addons', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  planHostNodeAddonRelay: vi.fn()
}))

vi.mock('./ssh-target-registry', () => ({ getSshTargetRegistryStore: vi.fn(() => null) }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

vi.mock('./remote-node-runtime-store-gc', () => ({
  gcRemoteNodeRuntimeStore: vi.fn().mockResolvedValue({ state: 'skipped', reason: 'test' })
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { gcRemoteNodeRuntimeStore } from './remote-node-runtime-store-gc'
import { execCommand } from './ssh-relay-deploy-helpers'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import {
  finalizeInstall,
  gcOldRelayVersions,
  isRelayAlreadyInstalled
} from './ssh-relay-versioned-install'
import {
  PinnedRelayFallbackError,
  planPinnedNodeRelay,
  resolvePinnedRelayTargetFacts,
  type PinnedRelayPlan
} from './ssh-relay-pinned-node'
import { ensurePinnedRelayRuntime, verifyPinnedRelayInstall } from './ssh-relay-pinned-node-install'
import { planHostNodeAddonRelay, type HostNodeAddonRelayPlan } from './ssh-relay-host-node-addons'
import { RemoteRuntimeUnavailableError } from './ssh-relay-runtime-resolution'
import { resetSshRemoteRuntimeTelemetryForTests } from './ssh-remote-runtime-telemetry'
import { getSshTargetRegistryStore } from './ssh-target-registry'
import { track } from '../telemetry/client'
import type { SshConnection } from './ssh-connection'
import type { SshConnectionStore } from './ssh-connection-store'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_COMPAT_ASSETS } from '../../shared/node-runtime-pin'
import type { SshRemoteRuntime, SshTarget } from '../../shared/ssh-types'
import { terminalUnavailableCauseFromError } from '../../shared/terminal-unavailable-cause'
import { decodeRemotePowerShellScript } from './ssh-remote-powershell'

const PINNED_VERSION = '0.1.0+feedfacecafe'
const RUNTIME_SHA = NODE_RUNTIME_ASSETS['linux-x64-glibc'].executableSha256
const PINNED_NODE = `/home/user/.orca-remote/runtimes/node-${RUNTIME_SHA}/bin/node`
const COMPAT_SHA = NODE_RUNTIME_COMPAT_ASSETS['linux-x64-glibc217'].executableSha256
const COMPAT_NODE = `/home/user/.orca-remote/runtimes/node-${COMPAT_SHA}/bin/node`

function pinnedPlan(): PinnedRelayPlan {
  return {
    kind: 'pinned-node',
    target: 'linux-x64-glibc',
    glibc: { major: 2, minor: 31 },
    fullVersion: PINNED_VERSION,
    addons: { dir: '/tmp/addons', digest: 'd', dispose: vi.fn().mockResolvedValue(undefined) },
    runtimeArchive: vi.fn()
  }
}

const HOST_NODE_VERSION = '0.1.0+0123456789ab'

function hostNodePlan(): HostNodeAddonRelayPlan {
  return {
    kind: 'host-node-addons',
    target: 'linux-x64-glibc',
    glibc: { major: 2, minor: 31 },
    fullVersion: HOST_NODE_VERSION,
    addons: { dir: '/tmp/host-addons', digest: 'd', dispose: vi.fn().mockResolvedValue(undefined) },
    nodePath: '/opt/node18/bin/node',
    hostNode: { version: { major: 18, minor: 20 }, napi: 9 }
  }
}

function makeConnection(remoteRuntime?: SshRemoteRuntime): SshConnection {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the deploy path under test touches only these members of the connection.
  return {
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(true),
    getTarget: () => ({ id: 'target-1', ...(remoteRuntime ? { remoteRuntime } : {}) }),
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    })
  } as unknown as SshConnection
}

function detachedLaunchCommand(conn: SshConnection): string | undefined {
  return vi
    .mocked(conn.exec)
    .mock.calls.map(([cmd]) => String(cmd))
    .find((cmd) => cmd.includes('--detached'))
}

function queueInstalledPinnedLaunch(): void {
  vi.mocked(execCommand)
    .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    .mockResolvedValueOnce('/home/user')
    .mockResolvedValueOnce('') // launch namespace marker
    .mockResolvedValueOnce('DEAD')
    .mockResolvedValueOnce('READY')
}

function queueInstalledLegacyLaunch(options: { platformProbed?: boolean } = {}): void {
  // A later ladder step reuses the platform the first step detected.
  if (!options.platformProbed) {
    vi.mocked(execCommand).mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
  }
  vi.mocked(execCommand)
    .mockResolvedValueOnce('/home/user')
    .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    .mockResolvedValueOnce('') // launch namespace marker
    .mockResolvedValueOnce('DEAD')
    .mockResolvedValueOnce('READY')
}

describe('deployAndLaunchRelay on the pinned Node runtime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    vi.mocked(resolveRemoteNodePath).mockReset().mockResolvedValue('/usr/bin/node')
    vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(true)
    vi.mocked(planPinnedNodeRelay).mockReset().mockResolvedValue(pinnedPlan())
    vi.mocked(ensurePinnedRelayRuntime).mockReset().mockResolvedValue(undefined)
    vi.mocked(resolvePinnedRelayTargetFacts)
      .mockReset()
      .mockResolvedValue({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 31 } })
    vi.mocked(planHostNodeAddonRelay)
      .mockReset()
      .mockRejectedValue(new PinnedRelayFallbackError('libc_floor', 'addons refused'))
    vi.mocked(getSshTargetRegistryStore).mockReset().mockReturnValue(null)
    resetSshRemoteRuntimeTelemetryForTests()
  })

  it('keeps the legacy host-Node path when the host has no runtime setting', async () => {
    const conn = makeConnection()
    queueInstalledLegacyLaunch()

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(planPinnedNodeRelay).not.toHaveBeenCalled()
    expect(result.nodePath).toBe('/usr/bin/node')
    expect(result.serverBuildId).toBe('0.1.0+abcdef012345')
  })

  it('launches from the runtime-folded version dir with the pinned Node and no host Node probe', async () => {
    const conn = makeConnection('pinned-node')
    queueInstalledPinnedLaunch()

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
    expect(result.serverBuildId).toBe(PINNED_VERSION)
    expect(result.remoteRelayDir).toBe(`/home/user/.orca-remote/relay-${PINNED_VERSION}`)
    expect(result.nodePath).toBe(PINNED_NODE)
    expect(detachedLaunchCommand(conn)).toContain(`'${PINNED_NODE}' relay.js --detached`)
    expect(
      vi.mocked(execCommand).mock.calls.some(([, cmd]) => String(cmd).includes('NATIVE-DEPS'))
    ).toBe(false)
  })

  it('collects the runtime store after a launch, keeping the pin it runs', async () => {
    const conn = makeConnection('pinned-node')
    queueInstalledPinnedLaunch()

    await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    await vi.waitFor(() => expect(gcRemoteNodeRuntimeStore).toHaveBeenCalledOnce())
    expect(gcRemoteNodeRuntimeStore).toHaveBeenCalledWith(
      conn,
      expect.objectContaining({ os: 'linux' }),
      '/home/user',
      // The compat runtime stays pinned too, so a rung A connect never collects rung B's.
      { currentPins: [RUNTIME_SHA, COMPAT_SHA] }
    )
    // Why after: the version pass is what drops the refs that held superseded runtimes.
    expect(vi.mocked(gcOldRelayVersions).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(gcRemoteNodeRuntimeStore).mock.invocationCallOrder[0]
    )
  })

  it('leaves the runtime store alone on the legacy host-Node path', async () => {
    const conn = makeConnection()
    queueInstalledLegacyLaunch()

    await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    await vi.waitFor(() => expect(gcOldRelayVersions).toHaveBeenCalled())
    await new Promise((resolve) => setImmediate(resolve))
    expect(gcRemoteNodeRuntimeStore).not.toHaveBeenCalled()
  })

  it('steps down the ladder to the host-npm relay on classified refusals', async () => {
    const conn = makeConnection('pinned-node')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ensurePinnedRelayRuntime).mockRejectedValueOnce(
      new PinnedRelayFallbackError('missing_lib', 'libstdc++.so.6: cannot open')
    )
    vi.mocked(planPinnedNodeRelay)
      .mockResolvedValueOnce(pinnedPlan())
      .mockResolvedValueOnce({ kind: 'host-node', fallbackReason: 'artifacts_unavailable' })
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
    queueInstalledLegacyLaunch({ platformProbed: true })

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(result.nodePath).toBe('/usr/bin/node')
    expect(result.serverBuildId).toBe('0.1.0+abcdef012345')
    expect(detachedLaunchCommand(conn)).toContain("'/usr/bin/node' relay.js --detached")
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rung A unavailable (missing_lib)'))
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('rung B unavailable (artifacts_unavailable)')
    )
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rung C unavailable (libc_floor)'))
    warn.mockRestore()
  })

  it('runs rung B on the glibc 2.17 compat runtime when rung A is below its glibc floor', async () => {
    const conn = makeConnection('pinned-node')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const oldGlibc = { major: 2, minor: 17 }
    vi.mocked(resolvePinnedRelayTargetFacts).mockResolvedValue({
      target: 'linux-x64-glibc',
      glibc: oldGlibc
    })
    vi.mocked(planPinnedNodeRelay)
      .mockResolvedValueOnce({ kind: 'host-node', fallbackReason: 'libc_floor' })
      .mockResolvedValueOnce({ ...pinnedPlan(), target: 'linux-x64-glibc217', glibc: oldGlibc })
    queueInstalledPinnedLaunch()

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(vi.mocked(planPinnedNodeRelay).mock.calls[1]?.[0]).toMatchObject({
      compat: { target: 'linux-x64-glibc217', glibcFloor: oldGlibc }
    })
    expect(result.nodePath).toBe(COMPAT_NODE)
    expect(detachedLaunchCommand(conn)).toContain(`'${COMPAT_NODE}' relay.js --detached`)
    expect(planHostNodeAddonRelay).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(gcRemoteNodeRuntimeStore).toHaveBeenCalledOnce())
    expect(vi.mocked(gcRemoteNodeRuntimeStore).mock.calls[0]?.[3]).toEqual({
      currentPins: [RUNTIME_SHA, COMPAT_SHA]
    })
    warn.mockRestore()
  })

  it('runs the ladder to rung B where this connect just recorded that managed orcad cannot run', async () => {
    const registry = {
      getTarget: vi.fn(() => ({
        id: 'target-1',
        managedServerUnavailable: { reason: 'runtime_self_test', appVersion: '1.0.0' }
      })),
      updateTarget: vi.fn(() => null)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ladder reads and writes only these two registry members.
    vi.mocked(getSshTargetRegistryStore).mockReturnValue(registry as unknown as SshConnectionStore)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const oldGlibc = { major: 2, minor: 17 }
    vi.mocked(resolvePinnedRelayTargetFacts).mockResolvedValue({
      target: 'linux-x64-glibc',
      glibc: oldGlibc
    })
    vi.mocked(planPinnedNodeRelay)
      .mockResolvedValueOnce({ kind: 'host-node', fallbackReason: 'libc_floor' })
      .mockResolvedValueOnce({ ...pinnedPlan(), target: 'linux-x64-glibc217', glibc: oldGlibc })
    queueInstalledPinnedLaunch()

    // The connection's own target predates the record and carries no runtime setting.
    const result = await deployAndLaunchRelay(makeConnection(), undefined, undefined, 'target-1')

    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
    expect(result.nodePath).toBe(COMPAT_NODE)
    expect(planHostNodeAddonRelay).not.toHaveBeenCalled()
  })

  it('skips rung B on a current glibc when rung A refused for a reason B cannot answer', async () => {
    const conn = makeConnection('pinned-node')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
      kind: 'host-node',
      fallbackReason: 'illegal_instruction'
    })
    queueInstalledLegacyLaunch()

    await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(planPinnedNodeRelay).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('rung B unavailable (runtime_unavailable)')
    )
    warn.mockRestore()
  })

  it('does not step down when the runtime check is unverifiable', async () => {
    const conn = makeConnection('pinned-node')
    const unverifiable = new Error('The pinned Node self-test is unverifiable')
    vi.mocked(ensurePinnedRelayRuntime).mockRejectedValueOnce(unverifiable)
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')

    await expect(deployAndLaunchRelay(conn, undefined, undefined, 'target-1')).rejects.toBe(
      unverifiable
    )
    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
    expect(detachedLaunchCommand(conn)).toBeUndefined()
    // No self-test ran, so there is no unverifiable runtime outcome to report.
    expect(track).not.toHaveBeenCalled()
  })

  it('releases the staged addons after the attempt', async () => {
    const conn = makeConnection('pinned-node')
    const plan = pinnedPlan()
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce(plan)
    queueInstalledPinnedLaunch()

    await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(plan.addons.dispose).toHaveBeenCalledOnce()
  })

  it('uploads the relay and its addons, then self-tests instead of installing native deps', async () => {
    const conn = makeConnection('pinned-node')
    const uploadDirectory = vi.fn().mockResolvedValue(undefined)
    Object.assign(conn, { uploadDirectory, writeFile: vi.fn().mockResolvedValue(undefined) })
    vi.mocked(isRelayAlreadyInstalled).mockReset().mockResolvedValue(false)
    vi.mocked(execCommand).mockImplementation((_conn, command) => {
      const marker = command.match(/\.sftp-namespace-[0-9a-f]{32}/u)?.[0]
      if (command.includes('uname')) {
        return Promise.resolve('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      }
      if (command === 'echo $HOME') {
        return Promise.resolve('/home/user')
      }
      if (command.includes('__ORCA_UPLOAD_STAGE_SLOT__') && marker) {
        return Promise.resolve(`__ORCA_UPLOAD_STAGE_SLOT__${marker}:slot-0`)
      }
      if (command.includes('__ORCA_UPLOAD_STAGE_PROMOTION__') && marker) {
        return Promise.resolve(`__ORCA_UPLOAD_STAGE_PROMOTION__${marker}:PROMOTED`)
      }
      if (command.includes('process.stdout.write("READY")')) {
        return Promise.resolve('READY')
      }
      return Promise.resolve(command.includes('test -S') ? 'DEAD' : '')
    })

    await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(uploadDirectory.mock.calls.map(([local]) => local)).toContain('/tmp/addons')
    expect(ensurePinnedRelayRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteRelayDir: `/home/user/.orca-remote/relay-${PINNED_VERSION}`
      }),
      false
    )
    expect(verifyPinnedRelayInstall).toHaveBeenCalledOnce()
    expect(vi.mocked(verifyPinnedRelayInstall).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(finalizeInstall).mock.invocationCallOrder[0]
    )
    expect(
      vi.mocked(execCommand).mock.calls.some(([, cmd]) => /npm (?:install|ci)/.test(String(cmd)))
    ).toBe(false)
    expect(detachedLaunchCommand(conn)).toContain(`'${PINNED_NODE}' relay.js --detached`)
  })

  it('runs rung C on the host Node with the prebuilt addons and no npm', async () => {
    const conn = makeConnection('pinned-node')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
      kind: 'host-node',
      fallbackReason: 'artifacts_unavailable'
    })
    const plan = hostNodePlan()
    vi.mocked(planHostNodeAddonRelay).mockReset().mockResolvedValueOnce(plan)
    queueInstalledPinnedLaunch()

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
    expect(ensurePinnedRelayRuntime).not.toHaveBeenCalled()
    expect(result.serverBuildId).toBe(HOST_NODE_VERSION)
    expect(result.nodePath).toBe('/opt/node18/bin/node')
    expect(detachedLaunchCommand(conn)).toContain("'/opt/node18/bin/node' relay.js --detached")
    expect(plan.addons.dispose).toHaveBeenCalledOnce()
    expect(track).toHaveBeenCalledWith(
      'ssh_remote_runtime_resolved',
      expect.objectContaining({
        rung: 'c',
        first_refusal: 'artifacts_unavailable',
        host_node_major: '18',
        host_libc: 'glibc',
        glibc_minor: '31'
      })
    )
  })

  it('goes straight to rung D on noexec, with the classified reason and no launch', async () => {
    const conn = makeConnection('pinned-node')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ensurePinnedRelayRuntime).mockRejectedValueOnce(
      new PinnedRelayFallbackError('noexec', 'exit 126: Permission denied')
    )
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')

    const failure = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1').catch(
      (error: unknown) => error
    )

    expect(failure).toBeInstanceOf(RemoteRuntimeUnavailableError)
    expect(String(failure)).toContain('mounted noexec')
    expect(terminalUnavailableCauseFromError(failure)).toMatchObject({
      status: 'blocked',
      reason: 'home_noexec',
      repairable: false
    })
    expect(planHostNodeAddonRelay).not.toHaveBeenCalled()
    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
    expect(detachedLaunchCommand(conn)).toBeUndefined()
    expect(track).toHaveBeenCalledWith(
      'ssh_remote_runtime_resolved',
      expect.objectContaining({ rung: 'd', first_refusal: 'noexec' })
    )
  })

  it('persists the rung A refusal under the host key and skips A on the next connect', async () => {
    const stored: Partial<SshTarget> = {}
    const registry = {
      getTarget: vi.fn(() => ({ id: 'target-1', ...stored })),
      updateTarget: vi.fn((_id: string, updates: Partial<SshTarget>) => {
        Object.assign(stored, updates)
        return null
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ladder reads and writes only these two registry members.
    vi.mocked(getSshTargetRegistryStore).mockReturnValue(registry as unknown as SshConnectionStore)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ensurePinnedRelayRuntime).mockRejectedValueOnce(
      new PinnedRelayFallbackError('illegal_instruction', 'SIGILL')
    )
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')
    queueInstalledLegacyLaunch({ platformProbed: true })

    await deployAndLaunchRelay(makeConnection('pinned-node'), undefined, undefined, 'target-1')

    expect(stored.remoteRuntimeResolution).toMatchObject({
      rung: 'legacy',
      pinnedRefusal: 'illegal_instruction',
      glibc: '2.31',
      runtimeSha256: RUNTIME_SHA
    })
    const persisted = vi.mocked(planPinnedNodeRelay).mock.calls[0]![0].persistedRefusal
    expect(persisted?.({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 31 } })).toBe(
      'illegal_instruction'
    )
    // A different glibc is a different key: the cached refusal no longer applies.
    expect(persisted?.({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 35 } })).toBeNull()
    expect(track).toHaveBeenCalledOnce()
  })

  it('launches a Windows relay on node.exe from the runtimes store, with no host Node probe', async () => {
    const conn = makeConnection('pinned-node')
    Object.assign(conn, { writeFile: vi.fn().mockResolvedValue(undefined) })
    const sha = NODE_RUNTIME_ASSETS['win32-x64'].executableSha256
    const nodeExe = `C:/Users/me/.orca-remote/runtimes/node-${sha}/node.exe`
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
      ...pinnedPlan(),
      target: 'win32-x64',
      glibc: null
    })
    vi.mocked(execCommand)
      .mockRejectedValueOnce(new Error('uname not found'))
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64')
      .mockResolvedValueOnce('C:\\Users\\me')
      .mockResolvedValueOnce('') // no persisted active pipe
      .mockResolvedValueOnce('WAITING') // named pipe probe
      .mockResolvedValueOnce('') // WMI relay launch
      .mockResolvedValueOnce('READY') // named pipe poll
      .mockResolvedValueOnce('') // persist active pipe marker

    const result = await deployAndLaunchRelay(conn, undefined, 300, 'target-1')

    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
    expect(result.nodePath).toBe(nodeExe)
    expect(result.remoteRelayDir).toBe(`C:/Users/me/.orca-remote/relay-${PINNED_VERSION}`)
    expect(ensurePinnedRelayRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ host: expect.objectContaining({ os: 'win32' }) }),
      true
    )
    const launchScript = vi
      .mocked(execCommand)
      .mock.calls.map(([, command]) => decodeRemotePowerShellScript(String(command)))
      .find((script) => script.includes('Invoke-CimMethod'))
    expect(launchScript).toContain(nodeExe)
  })
})
