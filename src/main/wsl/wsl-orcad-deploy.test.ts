import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type * as ManagedRuntimeContext from '../managed-server/lifecycle/orcad-managed-runtime-context'
import type * as RemoteVersionedInstall from '../managed-server/install/remote-versioned-install'
import { emptyOrcadActivationRecord } from '../managed-server/activation/orcad-activation-record'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
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
  localVersion: vi.fn(),
  readRecord: vi.fn()
}))
vi.mock('../managed-server/activation/orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.readRecord
}))
vi.mock('../managed-server/install/remote-versioned-install', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteVersionedInstall>()),
  readLocalFullVersion: mocks.localVersion
}))
vi.mock('./wsl-orcad-instance-adoption', () => ({ adoptUnrecordedWslOrcad: mocks.adopt }))

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
vi.mock('../managed-server/lifecycle/orcad-managed-version-gc', () => ({
  pruneManagedOrcadVersions: mocks.prune
}))
vi.mock('../managed-server/lifecycle/orcad-managed-wake', () => ({
  wakeStoppedManagedOrcad: mocks.wake
}))
vi.mock('../managed-server/lifecycle/orcad-managed-runtime-context', async (importOriginal) => ({
  ...(await importOriginal<typeof ManagedRuntimeContext>()),
  probeManagedOrcadReadiness: mocks.probe
}))

import { deployAndLaunchWslOrcad, isWsl1KernelRelease } from './wsl-orcad-deploy'

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
    holderState: vi.fn()
  }
}

let seenTarget: WslOrcadHostTarget | null = null
function transport(target: WslOrcadHostTarget): OrcadHostTransport {
  seenTarget = target
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
  return { getTarget: () => target } as unknown as OrcadHostTransport
}

function launch(kernel = '5.15.167.4-microsoft-standard-WSL2', options = {}) {
  mocks.exec.mockImplementation(async (_conn: unknown, command: string) => {
    if (command === 'uname -r') {
      mocks.steps.push('uname')
      return `${kernel}\n`
    }
    return '4242\n'
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
    expect(mocks.exec).toHaveBeenLastCalledWith(
      expect.anything(),
      "cat '/home/u/.orca-remote/orcad-1.5.0+ab/.orcad-pid' 2>/dev/null || true",
      expect.anything()
    )
  })

  it('applies the SSH census and downgrade admission to the first deploy', async () => {
    await launch()
    const options = mocks.deploy.mock.calls[0][0]
    expect(options).toMatchObject({
      census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null },
      appVersion: '1.5.0',
      localOrcadDir: '/local/orcad',
      target: 'linux-x64-glibc',
      recordedNodeRuntimeProbe: true
    })
    const newer = { ...emptyOrcadActivationRecord(), active: '2.0.0+cd', activeAppVersion: '2.0.0' }
    expect(options.admitRecord(newer, '1.5.0+ab')).toBe(
      "Orca 2.0.0 last ran this host's server, newer than this Orca (1.5.0). Update Orca to start it."
    )
  })

  it('refuses a WSL 1 distro before holding it or touching its files', async () => {
    await expect(launch('4.4.0-19041-Microsoft')).rejects.toMatchObject({
      name: 'OrcadHostUnsupportedError'
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

  // Real host (awin): a Remove that failed partway left orcad serving; the record named nothing.
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

describe('deployAndLaunchWslOrcad across an app update (E1)', () => {
  const INCUMBENT_READINESS = {
    ...READINESS,
    runtimeId: 'r-old',
    boundEndpoint: 'ws://127.0.0.1:6791'
  }
  const LIVE = {
    liveSessions: 2,
    startedSinceActivation: 0,
    daemonProtocolVersion: 3
  }
  const activeOld = {
    ...emptyOrcadActivationRecord(),
    active: '1.4.0+aa',
    activeAppVersion: '1.4.0',
    activatedAt: '2026-10-12T01:00:00.000Z'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.steps.length = 0
    mocks.resolveContext.mockImplementation(async (target: WslOrcadHostTarget, connection) => ({
      activationRecord: activeOld,
      serverTarget: 'linux-x64-glibc',
      connection,
      host,
      remoteHome: '/home/u',
      target,
      userDataDir: '/home/u/.orca'
    }))
    mocks.recover.mockResolvedValue({ outcome: 'none' })
    mocks.adopt.mockResolvedValue({ outcome: 'none' })
    mocks.probe.mockResolvedValue(READINESS)
    mocks.localVersion.mockReturnValue('1.5.0+ab')
    mocks.incumbent.mockResolvedValue({ census: LIVE, readiness: INCUMBENT_READINESS })
    mocks.readRecord.mockResolvedValue(activeOld)
  })

  it('plans the update on the census the running orcad reports, not an unknown one', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-and-activated',
      fullVersion: '1.5.0+ab',
      verdict: {}
    })
    await expect(launch()).resolves.toMatchObject({
      outcome: 'ready',
      fullVersion: '1.5.0+ab'
    })
    expect(mocks.incumbent).toHaveBeenCalledTimes(1)
    expect(mocks.deploy.mock.calls[0][0]).toMatchObject({
      census: LIVE,
      censusRecord: activeOld
    })
  })

  it('keeps the incumbent serving, with a forceable deferral, while terminals run', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '1.5.0+ab',
      code: 'orcad_update_terminals_running',
      reason: '2 terminals are running'
    })
    await expect(launch()).resolves.toEqual({
      outcome: 'ready',
      distro: 'Ubuntu-24.04',
      distroId: '0283592d-be56-40d4-b935-3dc18c3aa007',
      port: 6791,
      fullVersion: '1.4.0+aa',
      pid: 4242,
      readiness: INCUMBENT_READINESS,
      holder: 'spawned',
      deferredUpdate: {
        candidateVersion: '1.5.0+ab',
        code: 'orcad_update_terminals_running',
        reason: '2 terminals are running',
        forceable: true
      }
    })
    expect(mocks.exec).toHaveBeenLastCalledWith(
      expect.anything(),
      "cat '/home/u/.orca-remote/orcad-1.4.0+aa/.orcad-pid' 2>/dev/null || true",
      expect.anything()
    )
    // The installed candidate is what a later Force activates; nothing may collect it.
    expect(mocks.prune).not.toHaveBeenCalled()
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it('does not serve an incumbent another client replaced during the deploy', async () => {
    mocks.readRecord.mockResolvedValueOnce({ ...activeOld, active: '1.4.5+bb' })
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '1.5.0+ab',
      code: 'orcad_update_terminals_running',
      reason: 'terminals are running'
    })
    await expect(launch()).resolves.toMatchObject({ outcome: 'deferred', forceable: true })
  })

  it('forwards force to the update planner', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-and-activated',
      fullVersion: '1.5.0+ab',
      verdict: {}
    })
    await launch(undefined, { force: true })
    expect(mocks.deploy.mock.calls[0][0]).toMatchObject({
      force: true,
      census: LIVE
    })
  })

  it('reports a deferral when the incumbent could not be proven serving', async () => {
    mocks.incumbent.mockResolvedValueOnce({
      census: {
        liveSessions: null,
        startedSinceActivation: null,
        daemonProtocolVersion: null
      },
      readiness: null
    })
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '1.5.0+ab',
      code: 'orcad_update_terminal_census_unavailable',
      reason: 'no census'
    })
    await expect(launch()).resolves.toMatchObject({
      outcome: 'deferred',
      forceable: false
    })
  })

  it('does not serve the incumbent past a refusal that is not a wait', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '1.5.0+ab',
      code: 'orcad_activation_policy_refused',
      reason: 'newer Orca ran this host'
    })
    await expect(launch()).resolves.toMatchObject({
      outcome: 'deferred',
      forceable: true
    })
  })

  it('never asks the incumbent when it already runs this build', async () => {
    mocks.localVersion.mockReturnValue('1.4.0+aa')
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'already-active',
      fullVersion: '1.4.0+aa'
    })
    mocks.wake.mockResolvedValueOnce({ outcome: 'serving' })
    await launch()
    expect(mocks.incumbent).not.toHaveBeenCalled()
    expect(mocks.deploy.mock.calls[0][0].census.liveSessions).toBeNull()
  })
})

describe('isWsl1KernelRelease', () => {
  it('tells the WSL 1 syscall layer from a WSL 2 kernel, stock or custom', () => {
    expect(isWsl1KernelRelease('4.4.0-19041-Microsoft')).toBe(true)
    expect(isWsl1KernelRelease('4.4.0-22621-Microsoft\n')).toBe(true)
    expect(isWsl1KernelRelease('5.15.167.4-microsoft-standard-WSL2')).toBe(false)
    expect(isWsl1KernelRelease('6.6.36.6-microsoft-standard-WSL2+')).toBe(false)
    expect(isWsl1KernelRelease('6.10.0-custom')).toBe(false)
  })
})
