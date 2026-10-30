import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type * as ActiveProbe from './wsl-orcad-active-probe'
import type * as ManagedRuntimeContext from '../managed-server/lifecycle/orcad-managed-runtime-context'
import type * as RemoteVersionedInstall from '../managed-server/install/remote-versioned-install'
import { emptyOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { OrcadActiveReadinessError } from '../ssh/orcad-active-readiness'
import { WslDistroNotRunningError } from './wsl-orcad-connection-errors'
import type { WslDistroHolder } from './wsl-distro-holder'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'

const mocks = vi.hoisted(() => ({
  steps: new Array<string>(),
  exec: vi.fn(),
  resolveContext: vi.fn(),
  recover: vi.fn(),
  deploy: vi.fn(),
  probe: vi.fn(),
  prune: vi.fn(),
  wake: vi.fn(),
  adopt: vi.fn(),
  incumbent: vi.fn(),
  adoptRunning: vi.fn(),
  localVersion: vi.fn(),
  readRecord: vi.fn(),
  transaction: vi.fn(async (): Promise<unknown> => null)
}))
vi.mock('../managed-server/activation/orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.transaction
}))
vi.mock('../managed-server/activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.readRecord,
  orcadActivationPath: (_host: unknown, home: string) => `${home}/.orca-remote/orcad-active.json`
}))
vi.mock('../managed-server/install/remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteVersionedInstall>()),
  readLocalFullVersion: mocks.localVersion
}))
vi.mock('./wsl-orcad-instance-adoption', () => ({ adoptUnrecordedWslOrcad: mocks.adopt }))
vi.mock('../ssh/orcad-running-version-adoption', () => ({
  adoptRunningOrcadVersion: mocks.adoptRunning
}))

vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.5.0', getPath: () => '/user-data' })
}))
vi.mock('../ssh/remote-exec/remote-exec-command', () => ({ execCommand: mocks.exec }))
vi.mock('../managed-server/install/orcad-remote-context', () => ({
  resolveOrcadRemoteContext: mocks.resolveContext
}))
vi.mock('../managed-server/activation/orcad-activation-recovery', () => ({
  recoverInterruptedOrcadActivation: mocks.recover
}))
vi.mock('../orcad/orcad-artifact-materializer', () => ({
  materializeOrcadArtifact: async () => '/local/orcad'
}))
vi.mock('../ssh/orcad-remote-deploy', () => ({ deployOrcad: mocks.deploy }))
vi.mock('./wsl-orcad-active-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof ActiveProbe>()),
  probeWslActiveOrcad: async (...args: unknown[]) => ({
    readiness: await mocks.probe(...args),
    pid: 4242
  })
}))
vi.mock('../managed-server/lifecycle/orcad-managed-version-gc', () => ({
  provenLiveDaemonVersion: () => null,
  pruneManagedOrcadVersions: mocks.prune
}))
vi.mock('../managed-server/lifecycle/orcad-managed-wake', () => ({
  wakeStoppedManagedOrcad: mocks.wake
}))
vi.mock('../managed-server/lifecycle/orcad-managed-runtime-context', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedRuntimeContext>()),
  probeManagedOrcadReadiness: mocks.probe
}))

import { deployAndLaunchWslOrcad } from './wsl-orcad-deploy'
import { resetOrcadUpdateFailuresForTests } from '../managed-server/lifecycle/orcad-managed-update-failure-memory'

beforeEach(() => resetOrcadUpdateFailuresForTests())

const host = getRemoteHostPlatform('linux-x64')
const READINESS = {
  runtimeId: 'r1',
  boundEndpoint: 'ws://127.0.0.1:6790',
  advertisedEndpoint: null,
  managedWslCliReconciliation: 'settled' as const,
  pairing: { available: false as const, reason: 'disabled_by_operator', guidance: '' }
}

function holder(): WslDistroHolder {
  return {
    ensureHeld: vi.fn(async (distro: string) => {
      mocks.steps.push(`hold:${distro}`)
      return {
        outcome: 'spawned' as const,
        record: { version: 1 as const, distro, pid: 9, creationTimeMs: 1, startedAtMs: 1 }
      }
    }),
    adoptHolders: vi.fn(),
    release: vi.fn(),
    releaseAll: vi.fn(),
    holderState: vi.fn()
  }
}

let seenTarget: WslOrcadHostTarget | null = null
function transport(target: WslOrcadHostTarget): OrcadHostTransport {
  seenTarget = target
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
  return { getTarget: () => target } as unknown as OrcadHostTransport
}

const section = (text: string) => `${text}\n__ORCA_WSL_CONNECT_STATE_END__\n`
let snapshotAnswer = ''

function launch(kernel = '5.15.167.4-microsoft-standard-WSL2', options = {}) {
  mocks.exec.mockImplementation(async (_conn: unknown, command: string) => {
    if (command.includes('uname -r')) {
      mocks.steps.push('uname')
      return `__ORCA_WSL_KERNEL__ ${kernel}\n__ORCA_WSL_HOME__ /home/u\n\n__ORCA_REMOTE_PLATFORM__ Linux x86_64\n\n__ORCA_WSL_LIBC__\nldd (GNU libc) 2.39\n`
    }
    return command.includes('CONNECT_STATE_END') ? snapshotAnswer : '4242\n'
  })
  return deployAndLaunchWslOrcad('Ubuntu-24.04', {
    holder: holder(),
    createTransport: transport,
    readRegistryId: async () => '0283592d-be56-40d4-b935-3dc18c3aa007',
    readIncumbent: mocks.incumbent,
    ...options
  })
}

describe('deployAndLaunchWslOrcad', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.steps.length = 0
    seenTarget = null
    mocks.resolveContext.mockImplementation(async (target: WslOrcadHostTarget, connection) => {
      mocks.steps.push('context')
      return {
        activationRecord: emptyOrcadActivationRecord(),
        serverTarget: 'linux-x64-glibc',
        connection,
        host,
        remoteHome: '/home/u',
        target,
        userDataDir: '/home/u/.orca'
      }
    })
    mocks.recover.mockResolvedValue({ outcome: 'none' })
    mocks.adopt.mockImplementation(async () => {
      mocks.steps.push('adopt-check')
      return { outcome: 'none' }
    })
    mocks.deploy.mockImplementation(async () => {
      mocks.steps.push('deploy+launch')
      return { outcome: 'installed-and-activated', fullVersion: '1.5.0+ab', verdict: {} }
    })
    mocks.probe.mockResolvedValue(READINESS)
    mocks.localVersion.mockReturnValue('1.5.0+ab')
    mocks.incumbent.mockResolvedValue({
      census: {
        liveSessions: null,
        startedSinceActivation: null,
        daemonProtocolVersion: null
      },
      readiness: null
    })
  })

  it('holds the distro before it deploys and launches, and reports what C5 dials', async () => {
    await expect(launch()).resolves.toEqual({
      outcome: 'ready',
      distro: 'Ubuntu-24.04',
      distroId: '0283592d-be56-40d4-b935-3dc18c3aa007',
      port: 6790,
      fullVersion: '1.5.0+ab',
      pid: 4242,
      readiness: READINESS,
      holder: 'spawned'
    })
    expect(mocks.steps).toEqual([
      'uname',
      'hold:Ubuntu-24.04',
      'context',
      'adopt-check',
      'deploy+launch'
    ])
    expect(seenTarget).toEqual({
      kind: 'wsl',
      id: 'wsl:ubuntu-24.04',
      distro: 'Ubuntu-24.04',
      label: 'Ubuntu-24.04'
    })
    // The serving probe read the pid; nothing reads it again.
    expect(
      mocks.exec.mock.calls.some(([, command]) => String(command).includes('.orcad-pid'))
    ).toBe(false)
  })

  it.each([
    ['nothing pending', 'ABSENT', 'OPEN', { transactionAbsent: true, fenceOpen: true }],
    ['a held fence', 'ABSENT', 'LOCKED', { transactionAbsent: true, fenceOpen: false }],
    ['a pending journal', 'PRESENT\n{}', 'OPEN', { transactionAbsent: false, fenceOpen: true }]
  ])('passes its connect-state read (%s) on as hints', async (_, journal, fence, preRead) => {
    snapshotAnswer = `${section('ABSENT')}${section(journal)}${section('ABSENT')}${section('NONE')}${fence}\n`
    const resolve = mocks.resolveContext.getMockImplementation()
    mocks.resolveContext.mockImplementationOnce(async (target, connection, signal, h, known) => {
      const context = await resolve?.(target, connection, signal, h, known)
      const at = { conn: connection, host, remoteHome: '/home/u', userDataDir: '/home/u/.orca' }
      return { ...context, activationRecord: await known.readActivationRecord(at) }
    })
    await launch()
    // Recovery reads the host unless both are idle; deploy re-probes a fence seen held.
    expect(mocks.recover.mock.calls[0][1]).toMatchObject(preRead)
    expect(mocks.adopt.mock.calls[0][3]).toEqual({ state: 'absent' })
    expect(mocks.deploy.mock.calls[0][0].preRead.fenceOpen).toBe(preRead.fenceOpen)
  })

  it('applies the SSH census and downgrade admission to the first deploy', async () => {
    await launch()
    const options = mocks.deploy.mock.calls[0][0]
    expect(options).toMatchObject({
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null },
      appVersion: '1.5.0',
      localOrcadDir: '/local/orcad',
      target: 'linux-x64-glibc',
      recordedNodeRuntimeProbe: true,
      // A dropped network fails a first deploy in well under a minute.
      nodeRuntimeDownload: { desktopConnectTimeoutMs: 15_000, hostConnectTimeoutSeconds: 15 }
    })
    expect(options.preRead).toBeUndefined()
    const newer = { ...emptyOrcadActivationRecord(), active: '2.0.0+cd', activeAppVersion: '2.0.0' }
    expect(options.admitRecord(newer, '1.5.0+ab')).toBe(
      "Orca 2.0.0 last ran this host's server, newer than this Orca (1.5.0). Update Orca to start it."
    )
  })

  it('refuses a WSL 1 distro before holding it or touching its files', async () => {
    await expect(launch('4.4.0-19041-Microsoft')).rejects.toMatchObject({
      name: 'OrcadHostUnsupportedError',
      message: expect.stringContaining('wsl --set-version Ubuntu-24.04 2')
    })
    expect(mocks.steps).toEqual(['uname'])
  })

  it('tells an unregistered distro how to find the installed ones, before holding anything', async () => {
    mocks.exec.mockImplementation(async () => {
      mocks.steps.push('uname')
      throw new Error(
        'Command "uname -r" failed (exit 1): There is no distribution with the supplied name.\n' +
          'Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND'
      )
    })
    await expect(
      deployAndLaunchWslOrcad('Gone', { holder: holder(), createTransport: transport })
    ).rejects.toMatchObject({
      name: 'OrcadHostUnsupportedError',
      message: expect.stringContaining('wsl --list --verbose')
    })
    expect(mocks.steps).toEqual(['uname'])
  })

  it('surfaces an unsupported libc as the SSH host refusal does', async () => {
    const refusal = Object.assign(
      new Error('No Orca runtime supports linux-x64-glibc with glibc 2.17.'),
      {
        name: 'OrcadHostUnsupportedError'
      }
    )
    mocks.resolveContext.mockRejectedValueOnce(refusal)
    await expect(launch()).rejects.toBe(refusal)
    expect(mocks.deploy).not.toHaveBeenCalled()
  })

  it('starts an already-active slot the distro stop ended, instead of reporting it ready', async () => {
    mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: '1.5.0+ab' })
    mocks.wake.mockResolvedValueOnce({ outcome: 'started', readiness: READINESS })
    await expect(launch()).resolves.toMatchObject({ outcome: 'ready', port: 6790 })
    expect(mocks.wake).toHaveBeenCalledTimes(1)
  })

  it('does not wake again when a no-boot connect finds the distro stopped meanwhile', async () => {
    mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: '1.5.0+ab' })
    mocks.wake.mockResolvedValueOnce({ outcome: 'serving' })
    mocks.probe.mockRejectedValueOnce(new OrcadActiveReadinessError('exited', 'process has exited'))
    const requireRunning = vi.fn(async () => false)
    await expect(launch(undefined, { requireRunning })).rejects.toBeInstanceOf(
      WslDistroNotRunningError
    )
    expect(requireRunning).toHaveBeenCalledOnce()
    expect(mocks.wake).toHaveBeenCalledTimes(1)
  })

  // Real host (win-lowspec, cold systemd distro): the orcad the wake saw serving exited before the probe.
  it('starts the slot again when the orcad the wake saw serving exits before the probe', async () => {
    mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: '1.5.0+ab' })
    mocks.wake.mockResolvedValueOnce({ outcome: 'serving' })
    mocks.wake.mockResolvedValueOnce({ outcome: 'started', readiness: READINESS })
    mocks.probe.mockRejectedValueOnce(new OrcadActiveReadinessError('exited', 'process has exited'))
    await expect(launch()).resolves.toMatchObject({ outcome: 'ready', port: 6790 })
    expect(mocks.wake).toHaveBeenCalledTimes(2)

    mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: '1.5.0+ab' })
    mocks.wake.mockResolvedValueOnce({ outcome: 'serving' })
    const refused = new OrcadActiveReadinessError('rejected', 'wrong build')
    mocks.probe.mockRejectedValueOnce(refused)
    await expect(launch()).rejects.toBe(refused)
    expect(mocks.wake).toHaveBeenCalledTimes(3)
  })

  // Reproduce failed Remove leaving serving orcad absent from the activation record.
  it('deploys over an adopted unrecorded orcad under the SSH terminal gate, never a fresh launch', async () => {
    const adoptedRecord = {
      ...emptyOrcadActivationRecord(),
      active: '0.1.0+aa',
      activatedAt: '2026-10-12T01:00:00.000Z'
    }
    mocks.adopt.mockResolvedValueOnce({
      outcome: 'adopted',
      version: '0.1.0+aa',
      pid: 500,
      record: adoptedRecord
    })
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '1.5.0+ab',
      code: 'orcad_update_terminal_census_unavailable',
      reason: 'unknown census'
    })
    await expect(launch()).resolves.toMatchObject({ outcome: 'deferred', forceable: false })
    expect(mocks.deploy.mock.calls[0][0]).toMatchObject({
      censusRecord: adoptedRecord,
      census: { liveSessions: null, startedSinceActivation: null, daemonProtocolVersion: null }
    })
  })

  it('reports the adopted instance once the same version is serving', async () => {
    mocks.adopt.mockResolvedValueOnce({
      outcome: 'adopted',
      version: '1.5.0+ab',
      pid: 500,
      record: { ...emptyOrcadActivationRecord(), active: '1.5.0+ab' }
    })
    mocks.deploy.mockResolvedValueOnce({ outcome: 'already-active', fullVersion: '1.5.0+ab' })
    mocks.wake.mockResolvedValueOnce({ outcome: 'serving' })
    await expect(launch()).resolves.toMatchObject({
      outcome: 'ready',
      adoptedInstance: { version: '1.5.0+ab', pid: 500 }
    })
  })

  it('refuses to deploy or launch when an unrecorded orcad cannot be proven', async () => {
    mocks.adopt.mockRejectedValueOnce(
      Object.assign(new Error('cannot be identified'), { name: 'WslOrcadUnrecordedInstanceError' })
    )
    await expect(launch()).rejects.toMatchObject({ name: 'WslOrcadUnrecordedInstanceError' })
    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(mocks.wake).not.toHaveBeenCalled()
  })

  it('returns a deferral rather than launching over live terminals', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '1.6.0+ef',
      code: 'orcad_update_terminals_running',
      reason: 'terminals are running'
    })
    await expect(launch()).resolves.toEqual({
      outcome: 'deferred',
      distro: 'Ubuntu-24.04',
      candidateVersion: '1.6.0+ef',
      code: 'orcad_update_terminals_running',
      reason: 'terminals are running',
      forceable: true
    })
    expect(mocks.probe).not.toHaveBeenCalled()
  })
})
