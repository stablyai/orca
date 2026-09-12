import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn(),
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    'sshChannelCloseConfirmed' in error &&
    error.sshChannelCloseConfirmed === false
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
vi.mock('./orcad-activation-record-store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeOrcadActivationRecord: vi.fn().mockResolvedValue(undefined)
}))

import { execCommand } from './ssh-relay-deploy-helpers'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { uploadRelayDirectory, writeRelayFile } from './ssh-relay-install-transfers'
import { deployOrcad, type OrcadDeployOptions } from './orcad-remote-deploy'
import { writeOrcadActivationRecord } from './orcad-activation-record-store'
import { emptyOrcadActivationRecord, withActivatedVersion } from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshConnection } from './ssh-connection'
import { encodePairingOffer, PAIRING_OFFER_VERSION } from '../../shared/pairing'

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
  buildVersion?: string
  buildTarget?: 'linux-x64-glibc' | 'linux-x64-musl'
  runtimeKind?: 'bun' | 'node'
  daemonState?: 'live' | 'degraded' | 'absent'
  selfTestOk?: boolean
}): string {
  const buildVersion = overrides.buildVersion ?? NEW_VERSION
  const runtimeKind = overrides.runtimeKind ?? 'bun'
  const endpoint = 'ws://127.0.0.1:7777'
  return JSON.stringify({
    type: 'orca_server_ready',
    schemaVersion: 1,
    runtimeId: 'r1',
    boundEndpoint: 'ws://127.0.0.1:7777',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: 'public-key',
        pairedDeviceId: 'device-1',
        scope: 'runtime'
      }),
      endpoint,
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    },
    health: {
      buildHash: overrides.buildHash ?? 'abc123def4567890',
      buildVersion,
      nodeVersion: '20.11.0',
      nodeAbi: '115',
      runtimeKind,
      ...(runtimeKind === 'bun' ? { runtimeVersion: '1.4.0' } : {}),
      ptyBackend: runtimeKind === 'bun' ? 'bun-terminal' : 'node-pty',
      buildTarget: overrides.buildTarget ?? 'linux-x64-glibc',
      libc: 'glibc',
      platform: 'linux',
      arch: 'x64',
      pid: 1,
      terminalDaemon: {
        state: overrides.daemonState ?? 'live',
        ownsFreshSessions: (overrides.daemonState ?? 'live') === 'live',
        pid: 2,
        buildVersion,
        entryPath: '/x/daemon-entry.js',
        protocolVersion: 3,
        runtimeKind,
        ...(runtimeKind === 'bun' ? { runtimeVersion: '1.4.0' } : {}),
        ptyBackend: runtimeKind === 'bun' ? 'bun-terminal' : 'node-pty',
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
  snapshotCapture?: 'CAPTURED' | 'EMPTY' | 'FAILED'
  snapshotError?: Error
  snapshotRestore?: 'RESTORED' | 'FAILED'
  emptyStateRestore?: 'RESTORED' | 'FAILED'
  launchError?: Partial<Record<string, Error>>
  readinessError?: Partial<Record<string, Error>>
  buildHashError?: Error
  initialAdmission?: string
  initialAdmissionError?: Error
}

function commandBody(command: string): string {
  if (!command.includes('-EncodedCommand ')) {
    return command
  }
  const encoded = command.trim().split(/\s+/).at(-1) ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

function releasedActivationFence(): boolean {
  return mockExec.mock.calls.some(([, command]) => {
    const body = commandBody(String(command))
    return body.startsWith('rm -rf ') && body.includes('.orcad-activation-transaction')
  })
}

function scriptHost(script: HostScript): void {
  mockExec.mockImplementation(async (_conn, command: string) => {
    const text = String(command)
    const body = commandBody(text)
    if (body.includes('orcad-active.json') && body.includes('ReadAllText')) {
      return script.activationRecord
    }
    if (body.includes('cat ') && body.includes('orcad-active.json')) {
      return script.activationRecord
    }
    if (body.includes('__ORCAD_BUILD_HASH__')) {
      if (script.buildHashError) {
        throw script.buildHashError
      }
      return '__ORCAD_BUILD_HASH__ abc123def4567890'
    }
    if (body.includes('const owners=JSON.parse') || body.includes('$owners = @(')) {
      if (script.initialAdmissionError) {
        throw script.initialAdmissionError
      }
      return script.initialAdmission ?? 'CLEAR'
    }
    if (
      body.includes('.orcad-readiness') &&
      (body.startsWith('head -c ') || body.includes('Write-Output ([IO.File]::ReadAllText'))
    ) {
      const version = Object.keys(script.readiness).find((v) => body.includes(v))
      const readinessError = version ? script.readinessError?.[version] : undefined
      if (readinessError) {
        throw readinessError
      }
      return version ? script.readiness[version] : ''
    }
    if (body.includes('nohup') || body.includes('Start-Process')) {
      const version = body.includes(NEW_VERSION) ? NEW_VERSION : OLD_VERSION
      script.log.push(`launch:${version}`)
      const launchError = script.launchError?.[version]
      if (launchError) {
        throw launchError
      }
      return '9999'
    }
    if (body.includes('kill -TERM') || body.includes('.orcad-stop-request')) {
      script.log.push(`stop:${body.includes(NEW_VERSION) ? NEW_VERSION : OLD_VERSION}`)
      return 'STOPPED'
    }
    if ((body.includes('tar -C') || body.includes('tar.exe -C')) && body.includes('-cf')) {
      script.log.push('snapshot')
      if (script.snapshotError) {
        throw script.snapshotError
      }
      return script.snapshotCapture ?? 'CAPTURED'
    }
    if ((body.includes('tar -C') || body.includes('tar.exe -C')) && body.includes('-xf')) {
      script.log.push('restore')
      return script.snapshotRestore ?? 'RESTORED'
    }
    if (
      (body.includes('rm -rf') || body.includes('Remove-Item')) &&
      (body.includes('echo RESTORED') || body.includes("Write-Output 'RESTORED'"))
    ) {
      script.log.push('clear-state')
      return script.emptyStateRestore ?? 'RESTORED'
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
    buildTarget: 'linux-x64-glibc',
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

  it('makes every uploaded POSIX executable runnable after SFTP strips local modes', async () => {
    const script: HostScript = {
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)

    await deployOrcad(options())

    const chmodCommand = mockExec.mock.calls
      .map(([, command]) => commandBody(String(command)))
      .find((command) => command.includes('chmod 755'))
    expect(chmodCommand).toContain(`/home/u/.orca-remote/orcad-${NEW_VERSION}/bun-runtime`)
    expect(chmodCommand).toContain(`/home/u/.orca-remote/orcad-${NEW_VERSION}'/agent-browser-*`)
  })

  it('maps both bundle and version writes through the orcad SFTP namespace', async () => {
    const script: HostScript = {
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)

    await deployOrcad(options())

    const uploadMapping = vi.mocked(uploadRelayDirectory).mock.calls[0]?.[4]?.sftpNamespace
    expect(uploadMapping).toMatchObject({
      homeRelativeNamespaceRoot: `.orca-remote/orcad-${NEW_VERSION}`,
      homeRelativePath: `.orca-remote/orcad-${NEW_VERSION}`
    })
    const versionMapping = vi.mocked(writeRelayFile).mock.calls[0]?.[4]?.sftpNamespace
    expect(versionMapping).toMatchObject({
      homeRelativeNamespaceRoot: `.orca-remote/orcad-${NEW_VERSION}`,
      homeRelativePath: `.orca-remote/orcad-${NEW_VERSION}/.version`
    })
  })

  it('releases its install lock when a sibling completed the bundle while it waited', async () => {
    const script: HostScript = {
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    const { abandonInstall, isRemoteInstallComplete } =
      await import('./ssh-relay-versioned-install')
    vi.mocked(isRemoteInstallComplete).mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await deployOrcad(options())

    expect(uploadRelayDirectory).not.toHaveBeenCalled()
    expect(abandonInstall).toHaveBeenCalledWith(
      expect.anything(),
      `/home/u/.orca-remote/orcad-${NEW_VERSION}`,
      expect.objectContaining({ relayPlatform: 'linux-x64' })
    )
  })

  it('retains the install fence when upload teardown is unconfirmed', async () => {
    const script: HostScript = {
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    const error = Object.assign(new Error('transport lost during upload'), {
      sshChannelCloseConfirmed: false
    })
    vi.mocked(uploadRelayDirectory).mockRejectedValueOnce(error)

    await expect(deployOrcad(options())).rejects.toBe(error)

    const { abandonInstall } = await import('./ssh-relay-versioned-install')
    expect(abandonInstall).not.toHaveBeenCalled()
  })

  it('retains the activation fence when launch teardown is unconfirmed', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    const error = Object.assign(new Error('transport lost during launch'), {
      sshChannelCloseConfirmed: false
    })
    const baseImplementation = mockExec.getMockImplementation()
    mockExec.mockImplementation(async (conn, command, execOptions) => {
      if (String(command).includes('nohup') && String(command).includes(NEW_VERSION)) {
        throw error
      }
      return baseImplementation?.(conn, command, execOptions) ?? ''
    })

    await expect(deployOrcad(options())).rejects.toBe(error)

    expect(releasedActivationFence()).toBe(false)
  })

  it('recovers the incumbent when polling is aborted after launch', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: '',
        [OLD_VERSION]: readyLine({ buildVersion: OLD_VERSION, runtimeKind: 'node' })
      },
      log: []
    }
    scriptHost(script)
    const controller = new AbortController()

    await expect(
      deployOrcad(
        options({
          signal: controller.signal,
          sleep: async () => controller.abort()
        })
      )
    ).resolves.toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_candidate_launch_failed'
    })

    expect(script.log).toEqual([
      `stop:${OLD_VERSION}`,
      'snapshot',
      `launch:${NEW_VERSION}`,
      `stop:${NEW_VERSION}`,
      'restore',
      `launch:${OLD_VERSION}`
    ])
    expect(releasedActivationFence()).toBe(true)
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
    const written = vi.mocked(writeOrcadActivationRecord).mock.calls[0]?.[1]
    expect(written).toMatchObject({
      active: NEW_VERSION,
      previous: OLD_VERSION
    })
  })

  it.each([
    ['POSIX', {}],
    [
      'PowerShell',
      {
        host: getRemoteHostPlatform('win32-x64'),
        remoteHome: 'C:\\Users\\u',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        userDataDir: 'C:\\Users\\u\\.orca'
      }
    ]
  ] as const)('orders %s activation as stop, snapshot, launch', async (_label, overrides) => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)

    await deployOrcad(options(overrides))

    expect(script.log).toEqual([`stop:${OLD_VERSION}`, 'snapshot', `launch:${NEW_VERSION}`])
  })

  it('restarts the unchanged incumbent when a confirmed post-stop snapshot fails', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [OLD_VERSION]: readyLine({ buildVersion: OLD_VERSION, runtimeKind: 'node' })
      },
      log: [],
      snapshotCapture: 'FAILED'
    }
    scriptHost(script)

    const result = await deployOrcad(options())

    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      fullVersion: NEW_VERSION,
      code: 'orcad_pre_activation_snapshot_failed'
    })
    expect(script.log).toEqual([`stop:${OLD_VERSION}`, 'snapshot', `launch:${OLD_VERSION}`])
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      `orcad ${OLD_VERSION} was restarted and is serving again`
    )
  })

  it('does not claim snapshot-failure recovery when the incumbent health gate fails', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [OLD_VERSION]: readyLine({
          buildVersion: OLD_VERSION,
          runtimeKind: 'node',
          daemonState: 'degraded'
        })
      },
      log: [],
      snapshotCapture: 'FAILED'
    }
    scriptHost(script)

    const result = await deployOrcad(options())

    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_incumbent_restart_failed'
    })
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      'failed its recovery health gate'
    )
    expect(releasedActivationFence()).toBe(false)
  })

  it('does not stop an incumbent whose exact build identity cannot be read', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {},
      log: [],
      buildHashError: new Error('hash command unavailable')
    }
    scriptHost(script)

    const result = await deployOrcad(options())

    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_incumbent_identity_unverifiable'
    })
    expect(script.log).toEqual([])
  })

  it('reports the host down when incumbent restart after snapshot failure also fails', async () => {
    const restartError = new Error('incumbent launch failed')
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {},
      log: [],
      snapshotCapture: 'FAILED',
      launchError: { [OLD_VERSION]: restartError }
    }
    scriptHost(script)

    const result = await deployOrcad(options())

    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      fullVersion: NEW_VERSION,
      code: 'orcad_incumbent_restart_failed'
    })
    expect(script.log).toEqual([`stop:${OLD_VERSION}`, 'snapshot', `launch:${OLD_VERSION}`])
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      'This host is not serving orcad and requires recovery'
    )
    expect(releasedActivationFence()).toBe(false)
  })

  it('retains the activation fence when post-stop snapshot teardown is unconfirmed', async () => {
    const error = Object.assign(new Error('transport lost during snapshot'), {
      sshChannelCloseConfirmed: false
    })
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {},
      log: [],
      snapshotError: error
    }
    scriptHost(script)

    await expect(deployOrcad(options())).rejects.toBe(error)

    expect(script.log).toEqual([`stop:${OLD_VERSION}`, 'snapshot'])
    expect(script.log).not.toContain(`launch:${NEW_VERSION}`)
    expect(releasedActivationFence()).toBe(false)
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
      readiness: {
        [NEW_VERSION]: readyLine({ daemonState: 'degraded' }),
        [OLD_VERSION]: readyLine({ buildVersion: OLD_VERSION, runtimeKind: 'node' })
      },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ code: 'orcad_activation_daemon_degraded' })
    expect(writeOrcadActivationRecord).not.toHaveBeenCalled()
  })

  it('puts the previous version back after a rejected candidate, rather than leaving the host down', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({ selfTestOk: false }),
        [OLD_VERSION]: readyLine({ buildVersion: OLD_VERSION, runtimeKind: 'node' })
      },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ outcome: 'installed-not-activated' })
    expect(script.log).toEqual([
      `stop:${OLD_VERSION}`,
      'snapshot',
      `launch:${NEW_VERSION}`,
      `stop:${NEW_VERSION}`,
      'restore',
      `launch:${OLD_VERSION}`
    ])
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      `orcad ${OLD_VERSION} was restarted and is serving again`
    )
  })

  it('restores the incumbent after a confirmed candidate readiness failure', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({}),
        [OLD_VERSION]: readyLine({ buildVersion: OLD_VERSION, runtimeKind: 'node' })
      },
      readinessError: { [NEW_VERSION]: new Error('confirmed readiness read failed') },
      log: []
    }
    scriptHost(script)

    const result = await deployOrcad(options())

    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_candidate_launch_failed'
    })
    expect(script.log).toEqual([
      `stop:${OLD_VERSION}`,
      'snapshot',
      `launch:${NEW_VERSION}`,
      `stop:${NEW_VERSION}`,
      'restore',
      `launch:${OLD_VERSION}`
    ])
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      `orcad ${OLD_VERSION} was restarted and is serving again`
    )
  })

  it('does not claim rejected-candidate recovery when the incumbent answers unhealthy', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({ selfTestOk: false }),
        [OLD_VERSION]: readyLine({
          buildVersion: OLD_VERSION,
          runtimeKind: 'node',
          selfTestOk: false
        })
      },
      log: []
    }
    scriptHost(script)

    const result = await deployOrcad(options())

    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_incumbent_restart_failed'
    })
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      'failed its recovery health gate'
    )
  })

  it('refuses to activate when a different build answered the port', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({ buildHash: 'deadbeefdeadbeef' }),
        [OLD_VERSION]: readyLine({ buildVersion: OLD_VERSION, runtimeKind: 'node' })
      },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ code: 'orcad_activation_build_mismatch' })
  })

  it('refuses to activate a different native target than the host selected', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({ buildTarget: 'linux-x64-musl' }),
        [OLD_VERSION]: readyLine({ buildVersion: OLD_VERSION, runtimeKind: 'node' })
      },
      log: []
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ code: 'orcad_activation_build_target_mismatch' })
  })

  it('does not restart the incumbent when rejected-candidate state cannot be restored', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: { [NEW_VERSION]: readyLine({ daemonState: 'degraded' }) },
      log: [],
      snapshotRestore: 'FAILED'
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_incumbent_state_restore_failed'
    })
    expect(script.log).toEqual([
      `stop:${OLD_VERSION}`,
      'snapshot',
      `launch:${NEW_VERSION}`,
      `stop:${NEW_VERSION}`,
      'restore'
    ])
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      'was not restarted against potentially migrated state'
    )
    expect(releasedActivationFence()).toBe(false)
  })

  it('clears candidate-created state when the pre-activation root was empty', async () => {
    const script: HostScript = {
      activationRecord: ACTIVE_OLD,
      readiness: {
        [NEW_VERSION]: readyLine({ selfTestOk: false }),
        [OLD_VERSION]: readyLine({ buildVersion: OLD_VERSION, runtimeKind: 'node' })
      },
      log: [],
      snapshotCapture: 'EMPTY'
    }
    scriptHost(script)
    const result = await deployOrcad(options())
    expect(result).toMatchObject({ outcome: 'installed-not-activated' })
    expect(script.log).toContain('clear-state')
    expect(script.log.indexOf('clear-state')).toBeLessThan(
      script.log.indexOf(`launch:${OLD_VERSION}`)
    )
  })

  it('restores candidate-created state after a rejected first activation', async () => {
    const script: HostScript = {
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({ selfTestOk: false }) },
      log: [],
      snapshotCapture: 'EMPTY'
    }
    scriptHost(script)

    const result = await deployOrcad(options())

    expect(result).toMatchObject({ outcome: 'installed-not-activated' })
    expect(script.log).toEqual([
      'snapshot',
      `launch:${NEW_VERSION}`,
      `stop:${NEW_VERSION}`,
      'clear-state'
    ])
    expect(result.outcome === 'installed-not-activated' && result.reason).toContain(
      'pre-activation state was restored'
    )
  })

  it.each([
    ['live', 'LIVE orcad.lock 4242', 'orcad_initial_runtime_live'],
    ['unverifiable', 'UNVERIFIABLE orca-runtime.json', 'orcad_initial_runtime_unverifiable']
  ])(
    'refuses a first activation when an unmanaged runtime owner is %s',
    async (_label, initialAdmission, code) => {
      const script: HostScript = {
        activationRecord: '',
        readiness: { [NEW_VERSION]: readyLine({}) },
        log: [],
        initialAdmission
      }
      scriptHost(script)

      await expect(deployOrcad(options({ force: true }))).resolves.toMatchObject({
        outcome: 'installed-not-activated',
        code
      })

      expect(script.log).toEqual([])
      expect(writeOrcadActivationRecord).not.toHaveBeenCalled()
    }
  )

  it('treats a confirmed first-activation probe failure as unverifiable', async () => {
    const script: HostScript = {
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: [],
      initialAdmissionError: new Error('bun probe failed')
    }
    scriptHost(script)

    await expect(deployOrcad(options())).resolves.toMatchObject({
      outcome: 'installed-not-activated',
      code: 'orcad_initial_runtime_unverifiable'
    })

    expect(script.log).toEqual([])
    expect(writeOrcadActivationRecord).not.toHaveBeenCalled()
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

  it('re-reads the activation record after waiting for the host-wide lock', async () => {
    const script: HostScript = {
      activationRecord: '',
      readiness: { [NEW_VERSION]: readyLine({}) },
      log: []
    }
    scriptHost(script)
    vi.mocked(acquireInstallLock)
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(async () => {
        script.activationRecord = JSON.stringify(
          withActivatedVersion(
            emptyOrcadActivationRecord(),
            NEW_VERSION,
            null,
            new Date('2026-02-01T00:00:00.000Z')
          )
        )
      })

    await expect(deployOrcad(options())).resolves.toMatchObject({ outcome: 'already-active' })
    expect(script.log).toEqual([])
  })
})
