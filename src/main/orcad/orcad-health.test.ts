import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ParsedDaemonPid } from '../daemon/daemon-pid-file-parse'
import type { DaemonHealth } from '../daemon/daemon-health'

const {
  checkDaemonHealthMock,
  getDaemonEndpointFactsMock,
  readDaemonPidRecordMock,
  daemonOwnsFreshPersistentPtysMock
} = vi.hoisted(() => ({
  checkDaemonHealthMock: vi.fn<(socketPath: string, tokenPath: string) => Promise<DaemonHealth>>(),
  getDaemonEndpointFactsMock: vi.fn<() => unknown>(),
  readDaemonPidRecordMock: vi.fn<() => ParsedDaemonPid | null>(),
  daemonOwnsFreshPersistentPtysMock: vi.fn<() => boolean>()
}))

const reportedCoverage = vi.hoisted(() => ({ value: new Array<'pty-spawn' | 'handshake'>() }))
vi.mock('../daemon/daemon-health', () => ({
  checkDaemonHealthWithCoverage: async (socketPath: string, tokenPath: string) => ({
    verdict: await checkDaemonHealthMock(socketPath, tokenPath),
    coverage:
      reportedCoverage.value.shift() ?? (process.platform === 'win32' ? 'handshake' : 'pty-spawn')
  })
}))
vi.mock('../daemon/daemon-provider-state', () => ({
  getDaemonEndpointFacts: getDaemonEndpointFactsMock,
  readDaemonPidRecord: readDaemonPidRecordMock,
  daemonOwnsFreshPersistentPtys: daemonOwnsFreshPersistentPtysMock
}))

const { collectOrcadHealth, collectTerminalDaemonHealth, computeOrcadBuildHash } =
  await import('./orcad-health')

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
  spawnerExecPath: null,
  cgroupUnit: 'orca-daemon-n.scope'
}

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  getDaemonEndpointFactsMock.mockReturnValue(LIVE_FACTS)
  readDaemonPidRecordMock.mockReturnValue(PID_RECORD)
  daemonOwnsFreshPersistentPtysMock.mockReturnValue(true)
  checkDaemonHealthMock.mockResolvedValue('healthy')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.clearAllMocks()
})

describe('collectTerminalDaemonHealth', () => {
  it('reports live only when the daemon answered its own PTY spawn probe', async () => {
    const health = await collectTerminalDaemonHealth()
    expect(health.state).toBe('live')
    expect(health.selfTest).toMatchObject({ ok: true, verdict: 'healthy', coverage: 'pty-spawn' })
    expect(health.pid).toBe(4242)
    expect(health.buildVersion).toBe('1.2.2')
    expect(health.entryPath).toBe('/opt/orcad/daemon-entry.js')
    expect(health.protocolVersion).toBe(36)
    expect(health.cgroupUnit).toBe('orca-daemon-n.scope')
    // Probe the installed daemon’s exact endpoint, not a different responding process.
    expect(checkDaemonHealthMock).toHaveBeenCalledWith(LIVE_FACTS.socketPath, LIVE_FACTS.tokenPath)
  })

  it('is not green when the daemon is up but cannot spawn a PTY', async () => {
    checkDaemonHealthMock.mockResolvedValue('pty-spawn-unhealthy')
    const health = await collectTerminalDaemonHealth()
    expect(health.selfTest.ok).toBe(false)
    expect(health.selfTest.verdict).toBe('pty-spawn-unhealthy')
    expect(health.state).toBe('degraded')
  })

  it('is not green when the daemon stopped answering entirely', async () => {
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    const health = await collectTerminalDaemonHealth()
    expect(health.selfTest.ok).toBe(false)
    expect(health.state).toBe('degraded')
  })

  it('is not green when fresh terminals fall back to the local provider', async () => {
    daemonOwnsFreshPersistentPtysMock.mockReturnValue(false)
    const health = await collectTerminalDaemonHealth()
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
    expect(checkDaemonHealthMock).not.toHaveBeenCalled()
  })

  it('declares handshake-only coverage on win32, where the spawn probe is a no-op', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const health = await collectTerminalDaemonHealth()
    // Windows may prove only handshake: its fallback spawn probe performs no PTY round trip.
    expect(health.selfTest.coverage).toBe('handshake')
  })

  it('reports the coverage the daemon says its probe achieved', async () => {
    reportedCoverage.value.push('handshake')
    const health = await collectTerminalDaemonHealth()
    expect(health.selfTest).toMatchObject({ ok: true, coverage: 'handshake' })
  })
})

describe('collectOrcadHealth', () => {
  it('carries build identity and the Node ABI native addons must match', async () => {
    const health = await collectOrcadHealth('1.2.3')
    expect(health.buildVersion).toBe('1.2.3')
    expect(health.nodeVersion).toBe(process.versions.node)
    expect(health.nodeAbi).toBe(process.versions.modules)
    expect(health.platform).toBe(process.platform)
    expect(health.terminalDaemon.state).toBe('live')
  })

  it('includes bounded profile-state authority metadata when supplied', async () => {
    const health = await collectOrcadHealth('1.2.3', {
      backend: 'sqlite',
      classification: 'sqlite-only',
      authority_mode: 'sqlite-established',
      runtime: 'orcad',
      migrated: false
    })

    expect(health.profileStateAuthority).toEqual({
      backend: 'sqlite',
      classification: 'sqlite-only',
      authority_mode: 'sqlite-established',
      runtime: 'orcad',
      migrated: false
    })
  })
})

describe('computeOrcadBuildHash', () => {
  it('changes when the bundle bytes change, even at the same version string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orcad-build-hash-'))
    const entry = join(dir, 'orcad.js')
    writeFileSync(entry, 'build-a')
    const first = computeOrcadBuildHash(entry)
    writeFileSync(entry, 'build-b')
    expect(computeOrcadBuildHash(entry)).not.toBe(first)
  })

  it('answers unknown rather than throwing when the entry cannot be read', () => {
    expect(computeOrcadBuildHash(join(tmpdir(), 'definitely-absent-orcad.js'))).toBe('unknown')
    expect(computeOrcadBuildHash('')).toBe('unknown')
  })
})
