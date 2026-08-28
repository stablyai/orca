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
import type { SshConnection } from './ssh-connection'

const mockExec = vi.mocked(execCommand)
const NEW_VERSION = '0.2.0+bb01'
const OLD_VERSION = '0.1.0+aa01'

vi.mock('./ssh-relay-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readLocalFullVersion: () => '0.2.0+bb01',
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
    if (text.includes('nohup')) {
      script.log.push(`launch:${text.includes(NEW_VERSION) ? NEW_VERSION : OLD_VERSION}`)
      return '9999'
    }
    if (text.includes('kill -TERM')) {
      script.log.push(`stop:${text.includes(NEW_VERSION) ? NEW_VERSION : OLD_VERSION}`)
      return 'STOPPED'
    }
    if (text.includes('tar -C') && text.includes('-cf')) {
      script.log.push('snapshot')
      return 'CAPTURED'
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

  it('snapshots the shared data root before the candidate ever runs', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    await deployOrcad(options())
    expect(script.log.indexOf('snapshot')).toBeGreaterThan(-1)
    expect(script.log.indexOf('snapshot')).toBeLessThan(script.log.indexOf(`launch:${NEW_VERSION}`))
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
      'snapshot',
      `stop:${OLD_VERSION}`,
      `launch:${NEW_VERSION}`,
      `stop:${NEW_VERSION}`,
      `launch:${OLD_VERSION}`
    ])
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      `orcad ${OLD_VERSION} was restarted and is serving again`
    )
  })

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
