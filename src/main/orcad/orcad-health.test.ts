import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedDaemonPid } from '../daemon/daemon-pid-file-parse'
import type { DaemonHealthCheck } from '../daemon/daemon-health'

const {
  checkDaemonHealthWithCoverageMock,
  getDaemonEndpointFactsMock,
  readDaemonPidRecordMock,
  daemonOwnsFreshPersistentPtysMock
} = vi.hoisted(() => ({
  checkDaemonHealthWithCoverageMock: vi.fn<() => Promise<DaemonHealthCheck>>(),
  getDaemonEndpointFactsMock: vi.fn<() => unknown>(),
  readDaemonPidRecordMock: vi.fn<() => ParsedDaemonPid | null>(),
  daemonOwnsFreshPersistentPtysMock: vi.fn<() => boolean>()
}))

vi.mock('../daemon/daemon-health', () => ({
  checkDaemonHealthWithCoverage: checkDaemonHealthWithCoverageMock
}))
vi.mock('../daemon/daemon-init', () => ({
  getDaemonEndpointFacts: getDaemonEndpointFactsMock,
  readDaemonPidRecord: readDaemonPidRecordMock,
  daemonOwnsFreshPersistentPtys: daemonOwnsFreshPersistentPtysMock
}))

const {
  collectCachedOrcadHealth,
  collectOrcadHealth,
  collectTerminalDaemonHealth,
  computeOrcadBuildHash,
  libcFromOrcadBuildTarget,
  readOrcadBuildTarget
} = await import('./orcad-health')

const LIVE_FACTS = {
  runtimeDir: '/data/daemon',
  socketPath: '/data/daemon/daemon-v36.sock',
  tokenPath: '/data/daemon/daemon-v36.token',
  pidPath: '/data/daemon/daemon-v36.pid',
  protocolVersion: 36
}

const PID_RECORD: ParsedDaemonPid = {
  pid: 4242,
  startedAtMs: 1_000,
  entryPath: '/opt/orcad/daemon-entry.js',
  appVersion: '1.2.2',
  launchNonce: 'n',
  linuxStartTicks: null,
  bootId: null,
  spawnerExecPath: null
}

beforeEach(() => {
  getDaemonEndpointFactsMock.mockReturnValue(LIVE_FACTS)
  readDaemonPidRecordMock.mockReturnValue(PID_RECORD)
  daemonOwnsFreshPersistentPtysMock.mockReturnValue(true)
  checkDaemonHealthWithCoverageMock.mockResolvedValue({
    verdict: 'healthy',
    coverage: 'pty-spawn'
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('collectTerminalDaemonHealth', () => {
  it('reports live only when the daemon answered its own PTY spawn probe', async () => {
    const health = await collectTerminalDaemonHealth()
    expect(health.state).toBe('live')
    expect(health.selfTest).toMatchObject({ ok: true, verdict: 'healthy', coverage: 'pty-spawn' })
    expect(health.pid).toBe(4242)
    // The build the LIVE daemon came from, which can legitimately predate this orcad.
    expect(health.buildVersion).toBe('1.2.2')
    expect(health.entryPath).toBe('/opt/orcad/daemon-entry.js')
    expect(health.protocolVersion).toBe(36)
    // Why assert the coordinates: a self-test that probed some other endpoint would prove
    // nothing about the daemon this process installed.
    expect(checkDaemonHealthWithCoverageMock).toHaveBeenCalledWith(
      LIVE_FACTS.socketPath,
      LIVE_FACTS.tokenPath
    )
  })

  it('is not green when the daemon is up but cannot spawn a PTY', async () => {
    checkDaemonHealthWithCoverageMock.mockResolvedValue({
      verdict: 'pty-spawn-unhealthy',
      coverage: 'pty-spawn'
    })
    const health = await collectTerminalDaemonHealth()
    expect(health.selfTest.ok).toBe(false)
    expect(health.selfTest.verdict).toBe('pty-spawn-unhealthy')
    // Degraded, not absent: it still owns live sessions, and calling those exited would be
    // the verdict the execution-boundary vocabulary forbids guessing.
    expect(health.state).toBe('degraded')
  })

  it('is not green when the daemon stopped answering entirely', async () => {
    checkDaemonHealthWithCoverageMock.mockResolvedValue({
      verdict: 'unreachable',
      coverage: 'pty-spawn'
    })
    const health = await collectTerminalDaemonHealth()
    expect(health.selfTest.ok).toBe(false)
    expect(health.state).toBe('degraded')
  })

  it('is not green when fresh terminals fall back to the local provider', async () => {
    daemonOwnsFreshPersistentPtysMock.mockReturnValue(false)
    const health = await collectTerminalDaemonHealth()
    // The socket answers and the probe passes, but new terminals would die with this
    // process — reporting live here is precisely the looks-healthy-but-useless shape.
    expect(health.selfTest.ok).toBe(true)
    expect(health.ownsFreshSessions).toBe(false)
    expect(health.state).toBe('degraded')
  })

  it('reports absent, and probes nothing, when no daemon was ever installed', async () => {
    getDaemonEndpointFactsMock.mockReturnValue(null)
    daemonOwnsFreshPersistentPtysMock.mockReturnValue(false)
    const health = await collectTerminalDaemonHealth()
    expect(health.state).toBe('absent')
    expect(health.selfTest).toMatchObject({ ok: false, verdict: 'no-daemon' })
    expect(health.pid).toBeNull()
    expect(checkDaemonHealthWithCoverageMock).not.toHaveBeenCalled()
  })

  it('preserves handshake-only coverage reported for an adopted legacy daemon', async () => {
    checkDaemonHealthWithCoverageMock.mockResolvedValue({
      verdict: 'healthy',
      coverage: 'handshake'
    })
    const health = await collectTerminalDaemonHealth()
    expect(health.selfTest.coverage).toBe('handshake')
  })
})

describe('collectOrcadHealth', () => {
  it('identifies the actual host runtime separately from legacy Node ABI fields', async () => {
    const health = await collectOrcadHealth('1.2.3')
    expect(health.buildVersion).toBe('1.2.3')
    expect(health.nodeVersion).toBe(process.versions.node)
    expect(health.nodeAbi).toBe(process.versions.modules)
    expect(health.runtimeKind).toBe('node')
    expect(health.runtimeVersion).toBeUndefined()
    expect(health.ptyBackend).toBe('node-pty')
    expect(health.libc).toBe(
      process.platform === 'linux' ? expect.stringMatching(/glibc|musl/) : undefined
    )
    expect(health.platform).toBe(process.platform)
    expect(health.terminalDaemon.state).toBe('live')
  })

  it('coalesces repeated supervisor health polls inside the five-second window', async () => {
    const first = await collectCachedOrcadHealth('1.2.3', () => 1_000)
    const second = await collectCachedOrcadHealth('1.2.3', () => 2_000)

    expect(second).toBe(first)
    expect(checkDaemonHealthWithCoverageMock).toHaveBeenCalledOnce()
  })

  it('does not share an in-flight health result across build versions', async () => {
    const pending: ((value: DaemonHealthCheck) => void)[] = []
    checkDaemonHealthWithCoverageMock.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve))
    )

    const oldBuild = collectCachedOrcadHealth('build-old', () => 10_000)
    const newBuild = collectCachedOrcadHealth('build-new', () => 10_000)

    expect(checkDaemonHealthWithCoverageMock).toHaveBeenCalledTimes(2)
    pending[0]!({ verdict: 'healthy', coverage: 'pty-spawn' })
    pending[1]!({ verdict: 'healthy', coverage: 'pty-spawn' })

    await expect(oldBuild).resolves.toMatchObject({ buildVersion: 'build-old' })
    await expect(newBuild).resolves.toMatchObject({ buildVersion: 'build-new' })
  })
})

describe('orcad artifact build target', () => {
  it('reads the target marker beside the entry bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-build-target-'))
    const entry = join(dir, 'orcad.js')
    writeFileSync(entry, 'entry')
    writeFileSync(join(dir, '.build-target'), 'linux-x64-musl\n')

    expect(readOrcadBuildTarget(entry)).toBe('linux-x64-musl')
  })

  it('uses libc only from a target matching the runtime platform and architecture', () => {
    expect(libcFromOrcadBuildTarget('linux-x64-musl', 'linux', 'x64')).toBe('musl')
    expect(libcFromOrcadBuildTarget('linux-x64-glibc', 'linux', 'x64')).toBe('glibc')
    expect(libcFromOrcadBuildTarget('linux-arm64-musl', 'linux', 'x64')).toBeUndefined()
    expect(libcFromOrcadBuildTarget('darwin-x64', 'darwin', 'x64')).toBeUndefined()
  })

  it('rejects an unknown target marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-build-target-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'orcad.js'), 'entry')
    writeFileSync(join(dir, '.build-target'), 'linux-x64-future-libc\n')

    expect(readOrcadBuildTarget(join(dir, 'orcad.js'))).toBeUndefined()
  })
})

describe('computeOrcadBuildHash', () => {
  it('changes when the bundle bytes change, even at the same version string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-build-hash-'))
    const entry = join(dir, 'orcad.js')
    writeFileSync(entry, 'build-a')
    const first = computeOrcadBuildHash(entry)
    writeFileSync(entry, 'build-b')
    // A rollback that did not actually replace the file is what this has to catch, and a
    // version string cannot.
    expect(computeOrcadBuildHash(entry)).not.toBe(first)
  })

  it('answers unknown rather than throwing when the entry cannot be read', () => {
    expect(computeOrcadBuildHash(join(tmpdir(), 'definitely-absent-orcad.js'))).toBe('unknown')
    // A process with no argv[1] (an embedded host) still has to publish a readiness payload.
    expect(computeOrcadBuildHash('')).toBe('unknown')
  })
})
