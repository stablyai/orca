import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: () => false
}))
vi.mock('./ssh-connection-utils', () => ({ shellEscape: (s: string) => `'${s}'` }))
vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
}))
vi.mock('./ssh-relay-install-transfers', () => ({
  uploadRelayDirectory: vi.fn().mockResolvedValue(undefined),
  writeRelayFile: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('./orcad-local-build-hash', () => ({
  computeLocalOrcadBuildHash: () => 'abc123def4567890'
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import { deployOrcad, type OrcadDeployOptions } from './orcad-remote-deploy'
import { emptyOrcadActivationRecord, withActivatedVersion } from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { finalizeInstall } from './ssh-relay-versioned-install'
import type { SshConnection } from './ssh-connection'

const mockExec = vi.mocked(execCommand)
const NEW_VERSION = '0.2.0+bb0100000000'
const OLD_VERSION = '0.1.0+aa01'

vi.mock('./ssh-relay-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalFullVersion: () => '0.2.0+bb0100000000',
  isRemoteInstallComplete: vi.fn().mockResolvedValue(false),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined)
}))

function readyLine(overrides: {
  buildHash?: string
  daemonState?: 'live' | 'degraded' | 'absent'
  selfTestOk?: boolean
}): string {
  return JSON.stringify({
    type: 'orca_server_ready',
    schemaVersion: 1,
    runtimeId: 'r1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: { available: false, reason: 'disabled_by_operator', guidance: 'n/a' },
    health: {
      buildHash: overrides.buildHash ?? 'abc123def4567890',
      buildVersion: NEW_VERSION,
      nodeVersion: '20.11.0',
      nodeAbi: '115',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      terminalDaemon: {
        state: overrides.daemonState ?? 'live',
        ownsFreshSessions: (overrides.daemonState ?? 'live') === 'live',
        pid: 2,
        buildVersion: NEW_VERSION,
        entryPath: '/x/daemon-entry.js',
        protocolVersion: 3,
        selfTest: {
          ok: overrides.selfTestOk ?? true,
          coverage: 'pty-spawn',
          verdict: (overrides.selfTestOk ?? true) ? 'healthy' : 'pty-spawn-unhealthy',
          durationMs: 5
        }
      }
    }
  })
}

type HostScript = {
  activationRecord: string
  /** Readiness content per version dir, keyed by the version in the path. */
  readiness: Record<string, string>
  log: string[]
  preflightResult?: string
  snapshotResult?: string
  comparisonResult?: string
  candidateStopResult?: string
}

function scriptHost(script: HostScript): void {
  mockExec.mockImplementation(async (_conn, command: string) => {
    const text = String(command)
    if (text.startsWith('cat ') && text.includes('orcad-active.json')) {
      return script.activationRecord
    }
    if (text.includes('.orcad-readiness') && text.startsWith('cat ')) {
      const version = Object.keys(script.readiness).find((v) => text.includes(v))
      return version ? script.readiness[version] : ''
    }
    if (text.includes('--orcad-profile-state-preflight')) {
      script.log.push('preflight')
      return (
        script.preflightResult ??
        JSON.stringify({
          type: 'orca_profile_state_ready',
          nonce: text.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/)?.[0],
          runtime: 'bun',
          runtimeVersion: '1.4.2',
          sqliteVersion: '3.51.0',
          artifactVersion: NEW_VERSION,
          revision: 1
        })
      )
    }
    if (text.includes('nohup')) {
      script.log.push(`launch:${text.includes(NEW_VERSION) ? NEW_VERSION : OLD_VERSION}`)
      return '9999'
    }
    if (text.includes('kill -TERM')) {
      script.log.push(`stop:${text.includes(NEW_VERSION) ? NEW_VERSION : OLD_VERSION}`)
      return text.includes(NEW_VERSION) ? (script.candidateStopResult ?? 'STOPPED') : 'STOPPED'
    }
    if (text.includes('tar -C') && text.includes('-cf')) {
      script.log.push('snapshot')
      return script.snapshotResult ?? 'CAPTURED'
    }
    if (text.includes('verdict=UNCHANGED')) {
      script.log.push('compare-state')
      return script.comparisonResult ?? 'UNCHANGED'
    }
    return ''
  })
}

function options(overrides: Partial<OrcadDeployOptions> = {}): OrcadDeployOptions {
  return {
    conn: {} as SshConnection,
    host: getRemoteHostPlatform('linux-x64'),
    remoteHome: '/home/u',
    localOrcadDir: '/local/out/orcad',
    nodePath: '/usr/bin/node',
    userDataDir: '/home/u/.orca',
    bindHost: '127.0.0.1',
    port: 7777,
    census: { liveSessions: 0, startedSinceActivation: 0 },
    readinessTimeoutMs: 50,
    sleep: async () => {},
    now: () => new Date('2026-02-02T00:00:00.000Z'),
    ...overrides
  }
}

const ACTIVE_OLD = JSON.stringify(
  withActivatedVersion(emptyOrcadActivationRecord(), OLD_VERSION, null, new Date(0))
)

describe('deployOrcad', () => {
  it.each(['', '{"type":"orca_profile_state_ready","revision":0}'])(
    'leaves the incumbent and shared state alone when preflight returns %j',
    async (preflightResult) => {
      const script: HostScript = {
        activationRecord: ACTIVE_OLD,
        readiness: { [NEW_VERSION]: readyLine({}) },
        log: [],
        preflightResult
      }
      scriptHost(script)
      expect(await deployOrcad(options())).toMatchObject({
        outcome: 'installed-not-activated',
        code: 'orcad_candidate_preflight_failed'
      })
      expect(script.log).toEqual(['preflight'])
      expect(
        vi
          .mocked(writeRelayFile)
          .mock.calls.some(([, , path]) => path.includes('orcad-active.json'))
      ).toBe(false)
    }
  )

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('installs under the orcad namespace, not the relay one', async () => {
    const script: HostScript = {
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    await deployOrcad(options())
    expect(vi.mocked(acquireInstallLock).mock.calls[0][1]).toBe(
      `/home/u/.orca-remote/orcad-${NEW_VERSION}`
    )
    expect(vi.mocked(uploadRelayDirectory).mock.calls[0][2]).toContain(`orcad-${NEW_VERSION}`)
  })

  it.each(['linux-arm64', 'darwin-x64'] as const)(
    'marks the %s search binary executable before completing the install',
    async (platform) => {
      scriptHost({ activationRecord: '', readiness: {}, log: [] })
      await deployOrcad(
        options({
          host: getRemoteHostPlatform(platform),
          census: { liveSessions: 1, startedSinceActivation: 0 }
        })
      )
      const chmod = mockExec.mock.calls.findIndex(([, command]) =>
        String(command).startsWith('chmod 755 ')
      )
      expect(chmod).toBeGreaterThanOrEqual(0)
      expect(mockExec.mock.calls[chmod]?.[1]).toContain(`/ripgrep/${platform}/rg'`)
      expect(vi.mocked(uploadRelayDirectory).mock.invocationCallOrder[0]).toBeLessThan(
        mockExec.mock.invocationCallOrder[chmod]
      )
      expect(mockExec.mock.invocationCallOrder[chmod]).toBeLessThan(
        vi.mocked(finalizeInstall).mock.invocationCallOrder[0]
      )
    }
  )

  it('does not run chmod on a Windows remote', async () => {
    scriptHost({ activationRecord: '', readiness: {}, log: [] })
    await deployOrcad(
      options({
        host: getRemoteHostPlatform('win32-x64'),
        remoteHome: 'C:/Users/u',
        census: { liveSessions: 1, startedSinceActivation: 0 }
      })
    )
    expect(mockExec.mock.calls.some(([, command]) => String(command).startsWith('chmod '))).toBe(
      false
    )
  })

  it('leaves an upload incomplete when the remote cannot make search executable', async () => {
    mockExec.mockImplementation(async (_conn, command) => {
      if (String(command).startsWith('chmod 755 ')) {
        throw new Error('chmod failed')
      }
      return ''
    })
    await expect(deployOrcad(options())).rejects.toThrow('chmod failed')
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
  })

  it('activates a healthy candidate and records the outgoing version as the rollback target', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ outcome: 'installed-and-activated', fullVersion: NEW_VERSION })
    const written = vi
      .mocked(writeRelayFile)
      .mock.calls.find((call) => String(call[2]).endsWith('orcad-active.json'))
    expect(JSON.parse(String(written?.[3]))).toMatchObject({
      active: NEW_VERSION,
      previous: OLD_VERSION
    })
  })

  it('stops the incumbent before snapshotting, so SQLite WAL files are quiescent', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    await deployOrcad(options())
    expect(script.log.indexOf('snapshot')).toBeGreaterThan(-1)
    expect(script.log.indexOf('snapshot')).toBeLessThan(script.log.indexOf(`launch:${NEW_VERSION}`))
    expect(script.log.indexOf(`stop:${OLD_VERSION}`)).toBeLessThan(script.log.indexOf('snapshot'))
  })

  it('installs but does not activate when terminals are running', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(
      options({ census: { liveSessions: 2, startedSinceActivation: 0 } })
    )
    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_update_terminals_running'
    })
    // The bytes landed; nothing was stopped, launched or snapshotted.
    expect(vi.mocked(uploadRelayDirectory)).toHaveBeenCalled()
    expect(script.log).toEqual([])
  })

  it('does not write the activation record when the candidate fails its health gate', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({ daemonState: 'degraded' }) },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ code: 'orcad_activation_daemon_degraded' })
    expect(
      vi
        .mocked(writeRelayFile)
        .mock.calls.some((call) => String(call[2]).endsWith('orcad-active.json'))
    ).toBe(false)
  })

  it('puts the previous version back after a rejected candidate, rather than leaving the host down', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({ selfTestOk: false }),
        [OLD_VERSION]: readyLine({})
      },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ outcome: 'installed-not-activated' })
    expect(script.log).toEqual([
      'preflight',
      `stop:${OLD_VERSION}`,
      'snapshot',
      `launch:${NEW_VERSION}`,
      `stop:${NEW_VERSION}`,
      'compare-state',
      `launch:${OLD_VERSION}`
    ])
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      `orcad ${OLD_VERSION} was restarted and is serving again`
    )
  })

  it.each(['CHANGED', 'UNKNOWN', ''])(
    'preserves rejected candidate state when comparison is %s',
    async (comparisonResult) => {
      const script: HostScript = {
        activationRecord: ACTIVE_OLD,
        readiness: { [NEW_VERSION]: readyLine({ selfTestOk: false }) },
        log: [],
        comparisonResult
      }
      scriptHost(script)

      const result = await deployOrcad(options())

      expect(result).toMatchObject({ outcome: 'installed-not-activated' })
      expect(script.log).toEqual([
        'preflight',
        `stop:${OLD_VERSION}`,
        'snapshot',
        `launch:${NEW_VERSION}`,
        `stop:${NEW_VERSION}`,
        'compare-state'
      ])
      expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
        'recovery requires a fresh host terminal census'
      )
      expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
        '/home/u/.orca-remote/orcad-state-snapshots/'
      )
      expect(mockExec.mock.calls.some(([, command]) => command.includes('echo RESTORED'))).toBe(
        false
      )
    }
  )

  it('restarts the incumbent when a quiescent snapshot cannot be captured', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [OLD_VERSION]: readyLine({}) },
      log: [],
      snapshotResult: 'tar: write failed'
    }
    scriptHost(script)

    await expect(deployOrcad(options())).rejects.toThrow('incumbent was stopped')
    expect(script.log).toEqual([
      'preflight',
      `stop:${OLD_VERSION}`,
      'snapshot',
      `launch:${OLD_VERSION}`
    ])
  })

  it.each(['NO_PID', 'STILL_RUNNING', 'SIGNAL_FAILED', ''])(
    'does not inspect or replace state without confirmed candidate exit: %s',
    async (candidateStopResult) => {
      const script: HostScript = {
        activationRecord: ACTIVE_OLD,
        readiness: { [NEW_VERSION]: readyLine({ selfTestOk: false }) },
        log: [],
        candidateStopResult
      }
      scriptHost(script)

      await deployOrcad(options())

      expect(script.log).toEqual([
        'preflight',
        `stop:${OLD_VERSION}`,
        'snapshot',
        `launch:${NEW_VERSION}`,
        `stop:${NEW_VERSION}`
      ])
    }
  )

  it('refuses to activate when a different build answered the port', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({ buildHash: 'deadbeefdeadbeef' }),
        [OLD_VERSION]: readyLine({})
      },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ code: 'orcad_activation_build_mismatch' })
  })

  it('refuses to treat an unreadable activation record as an empty one', async () => {
    const script: HostScript = {
      activationRecord: JSON.stringify({ schemaVersion: 99, active: 'x' }),
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    await expect(deployOrcad(options())).rejects.toThrow('activation record')
    expect(vi.mocked(uploadRelayDirectory)).not.toHaveBeenCalled()
  })
})
