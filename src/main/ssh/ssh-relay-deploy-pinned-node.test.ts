import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isSshRelayOnHostNodeRuntime,
  recordSshRelayRuntimeStep
} from './ssh-host-node-runtime-mode'
import type * as RelayRipgrepInstallModule from './ssh-relay-ripgrep-install'
import type * as OrcadRemoteNodeRuntimeModule from './orcad-remote-node-runtime'
import type * as PinnedNodeInstallModule from './ssh-relay-pinned-node-install'

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

vi.mock('./ssh-remote-node-resolution', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
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

vi.mock('./orcad-remote-node-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof OrcadRemoteNodeRuntimeModule>()
  return {
    ...actual,
    ensureRemoteOrcadNodeRuntime: vi.fn(actual.ensureRemoteOrcadNodeRuntime)
  }
})

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
import { RemoteNodeNotFoundError, resolveRemoteNodePath } from './ssh-remote-node-resolution'
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
import {
  MUTABLE_PINNED_REFUSAL_REPLAY_MS,
  resetPinnedRuntimeRefusalsForTests
} from './ssh-relay-pinned-refusal-cache'
import { ensurePinnedRelayRuntime, verifyPinnedRelayInstall } from './ssh-relay-pinned-node-install'
import { planHostNodeAddonRelay, type HostNodeAddonRelayPlan } from './ssh-relay-host-node-addons'
import {
  ensureRemoteOrcadNodeRuntime,
  RemoteNodeRuntimeSelfTestError
} from './orcad-remote-node-runtime'
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

function queueInstalledLegacyLaunch(): void {
  vi.mocked(execCommand)
    .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    .mockResolvedValueOnce('/home/user')
    .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
    .mockResolvedValueOnce('') // launch namespace marker
    .mockResolvedValueOnce('DEAD')
    .mockResolvedValueOnce('READY')
}

/** A Linux host whose host-Node relay is installed and launches, answered by command text. */
function answerHostNodeLaunchByCommand(): void {
  const answers: [string, string][] = [
    ['uname', '__ORCA_REMOTE_PLATFORM__ Linux x86_64'],
    ['process.stdout.write("READY")', 'READY'],
    ['ORCA-NATIVE-DEPS-OK', 'ORCA-NATIVE-DEPS-OK'],
    ['test -S', 'DEAD']
  ]
  vi.mocked(execCommand).mockImplementation(async (_conn, command) =>
    command === 'echo $HOME'
      ? '/home/user'
      : (answers.find(([needle]) => command.includes(needle))?.[1] ?? '')
  )
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
    resetPinnedRuntimeRefusalsForTests()
  })

  it('runs the pinned ladder when the host has no runtime setting and nothing recorded', async () => {
    const conn = makeConnection()
    queueInstalledPinnedLaunch()

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
    expect(result.nodePath).toBe(PINNED_NODE)
    expect(result.serverBuildId).toBe(PINNED_VERSION)
    expect(
      vi.mocked(execCommand).mock.calls.some(([, cmd]) => String(cmd).includes('NATIVE-DEPS'))
    ).toBe(false)
  })

  it('keeps the host-npm path for a host that opts into Host Node', async () => {
    const conn = makeConnection('legacy')
    queueInstalledLegacyLaunch()

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(planPinnedNodeRelay).not.toHaveBeenCalled()
    expect(result.nodePath).toBe('/usr/bin/node')
    expect(result.serverBuildId).toBe('0.1.0+abcdef012345')
    expect(isSshRelayOnHostNodeRuntime('target-1')).toBe(true)
  })

  it('clears the Host Node marker once a later connect launches on the ladder', async () => {
    recordSshRelayRuntimeStep('target-1', true)
    queueInstalledPinnedLaunch()

    await deployAndLaunchRelay(makeConnection(), undefined, undefined, 'target-1')

    expect(isSshRelayOnHostNodeRuntime('target-1')).toBe(false)
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
    const conn = makeConnection('legacy')
    queueInstalledLegacyLaunch()

    await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    await vi.waitFor(() => expect(gcOldRelayVersions).toHaveBeenCalled())
    await new Promise((resolve) => setImmediate(resolve))
    expect(gcRemoteNodeRuntimeStore).not.toHaveBeenCalled()
  })

  it('falls back to the host-Node relay, as before the ladder, once A, B and C all refuse', async () => {
    const conn = makeConnection()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ensurePinnedRelayRuntime).mockRejectedValueOnce(
      new PinnedRelayFallbackError('missing_lib', 'libstdc++.so.6: cannot open')
    )
    vi.mocked(planPinnedNodeRelay)
      .mockResolvedValueOnce(pinnedPlan())
      .mockResolvedValueOnce({ kind: 'host-node', fallbackReason: 'missing_lib' })
    answerHostNodeLaunchByCommand()

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(result.nodePath).toBe('/usr/bin/node')
    // The fallback's strict probe found Node once; the launch reuses it.
    expect(resolveRemoteNodePath).toHaveBeenCalledOnce()
    expect(vi.mocked(resolveRemoteNodePath).mock.calls[0]?.[2]).toMatchObject({ strict: true })
    expect(isSshRelayOnHostNodeRuntime('target-1')).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rung A unavailable (missing_lib)'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rung B unavailable (missing_lib)'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rung C unavailable (libc_floor)'))
    warn.mockRestore()
  })

  it('keeps the host-Node relay, never rung D or a persisted decision, when this build lacks the orcad template', async () => {
    const registry = {
      getTarget: vi.fn(() => ({ id: 'target-1' })),
      updateTarget: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ladder reads and writes only these two registry members.
    vi.mocked(getSshTargetRegistryStore).mockReturnValue(registry as unknown as SshConnectionStore)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = 'The packaged orcad deployment template is missing'
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
      kind: 'host-node',
      fallbackReason: 'artifacts_unavailable'
    })
    vi.mocked(planHostNodeAddonRelay)
      .mockReset()
      .mockRejectedValueOnce(new PinnedRelayFallbackError('artifacts_unavailable', missing))
    const conn = makeConnection()
    queueInstalledLegacyLaunch()

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(result.nodePath).toBe('/usr/bin/node')
    expect(detachedLaunchCommand(conn)).toContain("'/usr/bin/node' relay.js --detached")
    expect(isSshRelayOnHostNodeRuntime('target-1')).toBe(true)
    expect(registry.updateTarget).not.toHaveBeenCalled()
    expect(track).toHaveBeenCalledWith(
      'ssh_remote_runtime_resolved',
      expect.objectContaining({ rung: 'legacy', first_refusal: 'artifacts_unavailable' })
    )
  })

  it('settles rung D after a client gap only once the host-Node fallback proves no Node', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
      kind: 'host-node',
      fallbackReason: 'artifacts_unavailable'
    })
    vi.mocked(planHostNodeAddonRelay)
      .mockReset()
      .mockRejectedValueOnce(new PinnedRelayFallbackError('host_node_missing', 'no Node 18+'))
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(
      new RemoteNodeNotFoundError('Node.js not found on remote host.')
    )
    vi.mocked(execCommand).mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')

    const failure = await deployAndLaunchRelay(
      makeConnection(),
      undefined,
      undefined,
      'target-1'
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RemoteRuntimeUnavailableError)
    expect(String(failure)).toContain('could not prepare its bundled Node.js')
    expect(terminalUnavailableCauseFromError(failure)).toMatchObject({ reason: 'no_runtime' })
    expect(vi.mocked(resolveRemoteNodePath).mock.calls[0]?.[2]).toMatchObject({ strict: true })
  })

  function queueWindowsPlatformProbe(): SshConnection {
    const conn = makeConnection()
    Object.assign(conn, { writeFile: vi.fn().mockResolvedValue(undefined) })
    vi.mocked(execCommand)
      .mockRejectedValueOnce(new Error('uname not found'))
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64')
    return conn
  }

  it('settles rung D with Windows wording when a Windows host has no Node to fall back to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
      kind: 'host-node',
      fallbackReason: 'security_software'
    })
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(
      new RemoteNodeNotFoundError('Node.js not found on remote host.')
    )

    const failure = await deployAndLaunchRelay(
      queueWindowsPlatformProbe(),
      undefined,
      300,
      'target-1'
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(RemoteRuntimeUnavailableError)
    expect(String(failure)).toContain('Windows host')
    expect(String(failure)).toContain('install Node.js 18+')
    expect(String(failure)).not.toContain('mounted noexec')
    expect(terminalUnavailableCauseFromError(failure)).toMatchObject({
      reason: 'no_runtime',
      host: { platform: 'win32' }
    })
  })

  it('keeps an unanswered host-Node probe a retryable failure, not rung D', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
      kind: 'host-node',
      fallbackReason: 'security_software'
    })
    const lost = new Error('channel closed')
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(lost)

    await expect(
      deployAndLaunchRelay(queueWindowsPlatformProbe(), undefined, 300, 'target-1')
    ).rejects.toBe(lost)
  })

  it('replays a Windows security-software refusal for a day, then re-proves rung A', async () => {
    const winSha = NODE_RUNTIME_ASSETS['win32-x64'].executableSha256
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
    vi.mocked(resolvePinnedRelayTargetFacts).mockResolvedValue({ target: 'win32-x64', glibc: null })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
      kind: 'host-node',
      fallbackReason: 'security_software'
    })
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(
      new RemoteNodeNotFoundError('Node.js not found on remote host.')
    )

    await deployAndLaunchRelay(queueWindowsPlatformProbe(), undefined, 300, 'target-1').catch(
      () => undefined
    )

    // Persisted with its proof time, so a restart doesn't re-upload to a host that still blocks it.
    expect(stored.remoteRuntimeResolution).toMatchObject({
      pinnedRefusal: 'security_software',
      runtimeSha256: winSha,
      refusedAt: expect.any(Number)
    })
    const persisted = vi.mocked(planPinnedNodeRelay).mock.calls[0]![0].persistedRefusal
    const winFacts = { target: 'win32-x64' as const, glibc: null }
    expect(persisted?.(winFacts)).toBe('security_software')
    stored.remoteRuntimeResolution = {
      ...stored.remoteRuntimeResolution!,
      refusedAt: Date.now() - MUTABLE_PINNED_REFUSAL_REPLAY_MS
    }
    expect(persisted?.(winFacts)).toBeNull()
  })

  it.each(['missing_lib', 'security_software', 'noexec', 'artifacts_unavailable'] as const)(
    'keeps a Windows host on the host-Node relay after rung A refuses for %s',
    async (reason) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const conn = makeConnection()
      Object.assign(conn, { writeFile: vi.fn().mockResolvedValue(undefined) })
      vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
        kind: 'host-node',
        fallbackReason: reason
      })
      vi.mocked(execCommand)
        .mockRejectedValueOnce(new Error('uname not found'))
        .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Windows X64')
        .mockResolvedValueOnce('C:\\Users\\me')
        .mockResolvedValueOnce('ORCA-NATIVE-DEPS-OK')
        .mockResolvedValueOnce('') // no persisted active pipe
        .mockResolvedValueOnce('WAITING') // named pipe probe
        .mockResolvedValueOnce('') // WMI relay launch
        .mockResolvedValueOnce('READY') // named pipe poll
        .mockResolvedValueOnce('') // persist active pipe marker

      const result = await deployAndLaunchRelay(conn, undefined, 300, 'target-1')

      expect(resolveRemoteNodePath).toHaveBeenCalled()
      expect(result.serverBuildId).toBe('0.1.0+abcdef012345')
      expect(planHostNodeAddonRelay).not.toHaveBeenCalled()
      expect(isSshRelayOnHostNodeRuntime('target-1')).toBe(true)
    }
  )

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

  it('skips rung B on a current glibc when rung A refused for a reason B cannot answer', async () => {
    const conn = makeConnection('pinned-node')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(planPinnedNodeRelay).mockResolvedValueOnce({
      kind: 'host-node',
      fallbackReason: 'illegal_instruction'
    })
    vi.mocked(execCommand).mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(
      new RemoteNodeNotFoundError('Node.js not found on remote host.')
    )

    await expect(
      deployAndLaunchRelay(conn, undefined, undefined, 'target-1')
    ).rejects.toBeInstanceOf(RemoteRuntimeUnavailableError)

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

  it("steps past rung A to the host's Node when NixOS's stub loader refuses the pinned Node", async () => {
    const conn = makeConnection()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const actualInstall = await vi.importActual<typeof PinnedNodeInstallModule>(
      './ssh-relay-pinned-node-install'
    )
    vi.mocked(ensurePinnedRelayRuntime).mockImplementationOnce(
      actualInstall.ensurePinnedRelayRuntime
    )
    vi.mocked(ensureRemoteOrcadNodeRuntime).mockRejectedValueOnce(
      new RemoteNodeRuntimeSelfTestError(
        127,
        `Could not start dynamically linked executable: ${PINNED_NODE}\n` +
          'NixOS cannot run dynamically linked executables intended for generic\n' +
          'linux environments out of the box. For more information, see:\n' +
          'https://nix.dev/permalink/stub-ld'
      )
    )
    const nixNode = '/run/current-system/sw/bin/node'
    vi.mocked(planHostNodeAddonRelay)
      .mockReset()
      .mockResolvedValueOnce({ ...hostNodePlan(), nodePath: nixNode })
    vi.mocked(execCommand).mockImplementation(async (_conn, command) => {
      if (command.includes('uname')) {
        return '__ORCA_REMOTE_PLATFORM__ Linux x86_64'
      }
      if (command === 'echo $HOME') {
        return '/home/user'
      }
      if (command.includes('process.stdout.write("READY")')) {
        return 'READY'
      }
      return command.includes('test -S') ? 'DEAD' : ''
    })

    const result = await deployAndLaunchRelay(conn, undefined, undefined, 'target-1')

    expect(ensureRemoteOrcadNodeRuntime).toHaveBeenCalledOnce()
    expect(result.nodePath).toBe(nixNode)
    expect(detachedLaunchCommand(conn)).toContain(`'${nixNode}' relay.js --detached`)
    expect(
      vi.mocked(execCommand).mock.calls.some(([, cmd]) => /NATIVE-DEPS|npm /.test(String(cmd)))
    ).toBe(false)
    expect(track).toHaveBeenCalledWith(
      'ssh_remote_runtime_resolved',
      expect.objectContaining({ rung: 'c', first_refusal: 'wrong_libc' })
    )
  })

  it('tries the host-Node fallback after a proved noexec, reaching D only on its answer', async () => {
    const conn = makeConnection('pinned-node')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.mocked(ensurePinnedRelayRuntime).mockRejectedValueOnce(
      new PinnedRelayFallbackError('noexec', 'exit 126: Permission denied')
    )
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(
      new RemoteNodeNotFoundError('Node.js not found on remote host.')
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
    // B and C load addons from the same tree, so only the fallback can disprove the noexec.
    expect(planHostNodeAddonRelay).not.toHaveBeenCalled()
    expect(vi.mocked(resolveRemoteNodePath).mock.calls[0]?.[2]).toMatchObject({ strict: true })
    expect(detachedLaunchCommand(conn)).toBeUndefined()
    expect(track).toHaveBeenCalledWith(
      'ssh_remote_runtime_resolved',
      expect.objectContaining({ rung: 'd', first_refusal: 'noexec' })
    )
  })

  it('steps down on an answered but unclassified install failure (ENOSPC), not abort', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enospc = Object.assign(
      new Error('Command "tar -xzf" failed (exit 2): tar: write error: No space left on device'),
      { exitCode: 2, stdout: '' }
    )
    vi.mocked(ensurePinnedRelayRuntime).mockRejectedValueOnce(enospc)
    answerHostNodeLaunchByCommand()
    vi.mocked(planHostNodeAddonRelay)
      .mockReset()
      .mockRejectedValueOnce(new PinnedRelayFallbackError('host_node_missing', 'no Node 18+'))

    const result = await deployAndLaunchRelay(makeConnection(), undefined, undefined, 'target-1')

    expect(result.nodePath).toBe('/usr/bin/node')
    expect(isSshRelayOnHostNodeRuntime('target-1')).toBe(true)
  })

  it('keeps an unanswered install failure retryable rather than stepping down', async () => {
    const lost = Object.assign(new Error('channel lost'), { sshChannelCloseConfirmed: false })
    vi.mocked(ensurePinnedRelayRuntime).mockRejectedValueOnce(lost)
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/user')

    await expect(
      deployAndLaunchRelay(makeConnection(), undefined, undefined, 'target-1')
    ).rejects.toBe(lost)
    expect(planHostNodeAddonRelay).not.toHaveBeenCalled()
    expect(resolveRemoteNodePath).not.toHaveBeenCalled()
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
    vi.mocked(resolveRemoteNodePath).mockRejectedValueOnce(
      new RemoteNodeNotFoundError('Node.js not found on remote host.')
    )

    await expect(
      deployAndLaunchRelay(makeConnection('pinned-node'), undefined, undefined, 'target-1')
    ).rejects.toBeInstanceOf(RemoteRuntimeUnavailableError)

    expect(stored.remoteRuntimeResolution).toMatchObject({
      rung: 'D',
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
