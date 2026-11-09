import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from '../../managed-server/install/orcad-host-transport'
import type * as ActiveProbe from './wsl-orcad-active-probe'
import type * as ManagedRuntimeContext from '../../managed-server/lifecycle/orcad-managed-runtime-context'
import type * as RemoteVersionedInstall from '../../managed-server/install/remote-versioned-install'
import { emptyOrcadActivationRecord } from '../../managed-server/activation/orcad-activation-record'
import { getRemoteHostPlatform } from '../../ssh/remote-host/ssh-remote-platform'
import { OrcadActiveReadinessError } from '../../managed-server/activation/orcad-active-readiness'
import { WslDistroNotRunningError } from './wsl-orcad-connection-errors'
import type { WslDistroHolder } from '../discovery/wsl-distro-holder-types'
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
  removeFailed: vi.fn(),
  transaction: vi.fn(async (): Promise<unknown> => null)
}))
vi.mock('./wsl-orcad-failed-install-removal', () => ({
  removeFailedFreshWslOrcadInstall: mocks.removeFailed
}))
vi.mock('../../managed-server/activation/orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.transaction
}))
vi.mock('../../managed-server/activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.readRecord,
  orcadActivationPath: (_host: unknown, home: string) => `${home}/.orca-remote/orcad-active.json`
}))
vi.mock('../../managed-server/install/remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteVersionedInstall>()),
  readLocalFullVersion: mocks.localVersion
}))
vi.mock('./wsl-orcad-instance-adoption', () => ({ adoptUnrecordedWslOrcad: mocks.adopt }))
vi.mock('../../managed-server/activation/orcad-running-version-adoption', () => ({
  adoptRunningOrcadVersion: mocks.adoptRunning
}))

vi.mock('../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getVersion: () => '1.5.0', getPath: () => '/user-data' })
}))
vi.mock('../../ssh/remote-exec/remote-exec-command', () => ({ execCommand: mocks.exec }))
vi.mock('../../managed-server/install/orcad-remote-context', () => ({
  resolveOrcadRemoteContext: mocks.resolveContext
}))
vi.mock('../../managed-server/activation/orcad-activation-recovery', () => ({
  recoverInterruptedOrcadActivation: mocks.recover
}))
vi.mock('../../orcad/orcad-artifact-materializer', () => ({
  materializeOrcadArtifact: async () => '/local/orcad'
}))
vi.mock('../../managed-server/install/orcad-remote-deploy', () => ({ deployOrcad: mocks.deploy }))
vi.mock('./wsl-orcad-active-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof ActiveProbe>()),
  probeWslActiveOrcad: async (...args: unknown[]) => ({
    readiness: await mocks.probe(...args),
    pid: 4242
  })
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-version-gc', () => ({
  provenLiveDaemonVersion: () => null,
  pruneManagedOrcadVersions: mocks.prune,
  pruneSupersededOrcadCandidates: async () => {}
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-wake', () => ({
  wakeStoppedManagedOrcad: mocks.wake
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-runtime-context', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedRuntimeContext>()),
  probeManagedOrcadReadiness: mocks.probe
}))

import { deployAndLaunchWslOrcad } from './wsl-orcad-deploy'
import { resetOrcadUpdateFailuresForTests } from '../../managed-server/lifecycle/orcad-managed-update-failure-memory'

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

function transport(target: WslOrcadHostTarget): OrcadHostTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
  return { getTarget: () => target } as unknown as OrcadHostTransport
}
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

  it('refuses to deploy or launch when an unrecorded orcad cannot be proven', async () => {
    mocks.adopt.mockRejectedValueOnce(
      Object.assign(new Error('cannot be identified'), { name: 'WslOrcadUnrecordedInstanceError' })
    )
    await expect(launch()).rejects.toMatchObject({ name: 'WslOrcadUnrecordedInstanceError' })
    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(mocks.wake).not.toHaveBeenCalled()
  })
})
