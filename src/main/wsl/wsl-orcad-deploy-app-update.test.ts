// Split from wsl-orcad-deploy.test.ts: the connect across an app update (E1), with the same host mocks.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import type * as ActiveProbe from './wsl-orcad-active-probe'
import type * as ManagedRuntimeContext from '../managed-server/lifecycle/orcad-managed-runtime-context'
import type * as RemoteVersionedInstall from '../managed-server/install/remote-versioned-install'
import {
  emptyOrcadActivationRecord,
  type OrcadActivationRecord
} from '../managed-server/activation/orcad-activation-record'
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

function transport(target: WslOrcadHostTarget): OrcadHostTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every host call is mocked at its module.
  return { getTarget: () => target } as unknown as OrcadHostTransport
}

function launch(kernel = '5.15.167.4-microsoft-standard-WSL2', options = {}) {
  mocks.exec.mockImplementation(async (_conn: unknown, command: string) => {
    if (command.includes('uname -r')) {
      mocks.steps.push('uname')
      return `__ORCA_WSL_KERNEL__ ${kernel}\n__ORCA_WSL_HOME__ /home/u\n\n__ORCA_REMOTE_PLATFORM__ Linux x86_64\n\n__ORCA_WSL_LIBC__\nldd (GNU libc) 2.39\n`
    }
    const end = '\n__ORCA_WSL_CONNECT_STATE_END__\n'
    return command.includes(end.trim()) ? `ABSENT${end}ABSENT${end}ABSENT${end}OPEN\n` : '4242\n'
  })
  return deployAndLaunchWslOrcad('Ubuntu-24.04', {
    holder: holder(),
    createTransport: transport,
    readRegistryId: async () => '0283592d-be56-40d4-b935-3dc18c3aa007',
    readIncumbent: mocks.incumbent,
    ...options
  })
}

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
    // Keep the installed candidate for later explicit Force activation.
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
    await launch(undefined, { intent: 'force' })
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

  describe('the SSH auto-update rules', () => {
    const newer = {
      ...activeOld,
      active: '2.0.0+cd',
      activeAppVersion: '2.0.0',
      previous: '1.5.0+ab'
    }
    const NEWER_READINESS = { ...INCUMBENT_READINESS, runtimeId: 'r-new' }
    const policyRefused = {
      outcome: 'installed-not-activated',
      fullVersion: '1.5.0+ab',
      code: 'orcad_activation_policy_refused',
      reason: 'newer Orca ran this host'
    }

    function withRecord(record: OrcadActivationRecord): void {
      mocks.resolveContext.mockImplementation(async (target: WslOrcadHostTarget, connection) => ({
        activationRecord: record,
        serverTarget: 'linux-x64-glibc',
        connection,
        host,
        remoteHome: '/home/u',
        target,
        userDataDir: '/home/u/.orca'
      }))
      mocks.readRecord.mockResolvedValue(record)
    }

    const adoptedAs = (version: string, readiness: typeof INCUMBENT_READINESS) => ({
      version,
      readiness,
      reprobe: async () => readiness
    })

    it('serves a newer build another Orca activated instead of deploying over it', async () => {
      withRecord(newer)
      mocks.deploy.mockResolvedValue(policyRefused)
      mocks.adoptRunning.mockResolvedValueOnce(adoptedAs('2.0.0+cd', NEWER_READINESS))
      await expect(launch()).resolves.toEqual({
        outcome: 'ready',
        distro: 'Ubuntu-24.04',
        distroId: '0283592d-be56-40d4-b935-3dc18c3aa007',
        port: 6791,
        fullVersion: '2.0.0+cd',
        pid: 4242,
        readiness: NEWER_READINESS,
        holder: 'spawned'
      })
      expect(mocks.adoptRunning).toHaveBeenCalledWith(expect.anything(), newer, '1.5.0+ab')
      expect(mocks.deploy).not.toHaveBeenCalled()
      expect(mocks.incumbent).not.toHaveBeenCalled()
      expect(mocks.prune).not.toHaveBeenCalled()
      expect(mocks.exec).toHaveBeenLastCalledWith(
        expect.anything(),
        "cat '/home/u/.orca-remote/orcad-2.0.0+cd/.orcad-pid' 2>/dev/null || true",
        expect.anything()
      )
    })

    it('does not re-activate the build this host rolled back from', async () => {
      withRecord({ ...activeOld, rolledBackFrom: '1.5.0+ab' })
      mocks.deploy.mockResolvedValue({
        outcome: 'installed-and-activated',
        fullVersion: '1.5.0+ab',
        verdict: {}
      })
      mocks.adoptRunning.mockResolvedValueOnce(adoptedAs('1.4.0+aa', INCUMBENT_READINESS))
      await expect(launch()).resolves.toMatchObject({
        outcome: 'ready',
        fullVersion: '1.4.0+aa',
        readiness: INCUMBENT_READINESS,
        deferredUpdate: {
          candidateVersion: '1.5.0+ab',
          code: 'orcad_activation_policy_refused',
          reason: expect.stringMatching(/rolled back from 1\.5\.0\+ab/),
          forceable: true
        }
      })
      expect(mocks.deploy).not.toHaveBeenCalled()
    })

    it('labels the launch with the build the adoption found serving, not the stale record', async () => {
      withRecord(newer)
      mocks.adoptRunning.mockResolvedValueOnce(adoptedAs('2.1.0+ef', NEWER_READINESS))
      await expect(launch()).resolves.toMatchObject({ outcome: 'ready', fullVersion: '2.1.0+ef' })
    })

    it('defers while another run holds the host fence', async () => {
      withRecord(newer)
      mocks.adoptRunning.mockResolvedValueOnce({
        outcome: 'deferred',
        candidateVersion: '1.5.0+ab',
        code: 'orcad_activation_fence_busy',
        reason: 'busy'
      })
      await expect(launch()).resolves.toEqual({
        outcome: 'deferred',
        distro: 'Ubuntu-24.04',
        candidateVersion: '1.5.0+ab',
        code: 'orcad_activation_fence_busy',
        reason: 'busy',
        forceable: false
      })
      expect(mocks.deploy).not.toHaveBeenCalled()
    })

    it('lets an explicit force deploy past both skips', async () => {
      withRecord({ ...newer, rolledBackFrom: '1.5.0+ab' })
      mocks.deploy.mockResolvedValueOnce({
        outcome: 'installed-and-activated',
        fullVersion: '1.5.0+ab',
        verdict: {}
      })
      await expect(launch(undefined, { intent: 'force' })).resolves.toMatchObject({
        outcome: 'ready',
        fullVersion: '1.5.0+ab'
      })
      expect(mocks.adoptRunning).not.toHaveBeenCalled()
    })

    it('refuses the rolled-back build under the fence when nothing could be adopted', async () => {
      const rolledBack = { ...activeOld, rolledBackFrom: '1.5.0+ab' }
      withRecord(rolledBack)
      mocks.deploy.mockResolvedValueOnce(policyRefused)
      mocks.adoptRunning.mockResolvedValueOnce(null)
      await expect(launch()).resolves.toMatchObject({ outcome: 'deferred', forceable: true })
      const { admitRecord } = mocks.deploy.mock.calls[0][0]
      expect(admitRecord(rolledBack, '1.5.0+ab')).toMatch(/rolled back from 1\.5\.0\+ab/)
      expect(admitRecord(activeOld, '1.5.0+ab')).toBeNull()
      expect(admitRecord(newer, '1.5.0+ab')).toMatch(/Orca 2\.0\.0 last ran/)
    })

    const rejected = {
      outcome: 'installed-not-activated',
      fullVersion: '1.5.0+ab',
      code: 'orcad_candidate_readiness_rejected',
      reason: 'the candidate never became ready; the incumbent was restored'
    }

    it('does not retry a candidate rejected earlier this launch, and serves the incumbent', async () => {
      mocks.deploy.mockResolvedValue(rejected)
      await expect(launch()).resolves.toMatchObject({ outcome: 'deferred' })
      mocks.adoptRunning.mockResolvedValueOnce(adoptedAs('1.4.0+aa', INCUMBENT_READINESS))
      await expect(launch()).resolves.toMatchObject({
        outcome: 'ready',
        fullVersion: '1.4.0+aa',
        deferredUpdate: {
          candidateVersion: '1.5.0+ab',
          code: 'orcad_candidate_readiness_rejected',
          reason: rejected.reason,
          forceable: true
        }
      })
      expect(mocks.deploy).toHaveBeenCalledTimes(1)
      await launch(undefined, { intent: 'force' })
      expect(mocks.deploy).toHaveBeenCalledTimes(2)
    })

    it('serves the restored incumbent on the very connect that rejected the candidate', async () => {
      mocks.deploy.mockResolvedValueOnce(rejected)
      mocks.adoptRunning.mockResolvedValueOnce(adoptedAs('1.4.0+aa', INCUMBENT_READINESS))
      await expect(launch()).resolves.toMatchObject({
        outcome: 'ready',
        fullVersion: '1.4.0+aa',
        deferredUpdate: { code: 'orcad_candidate_readiness_rejected', forceable: true }
      })
    })

    it('retries a failed candidate on Update, and still defers over live terminals', async () => {
      mocks.deploy.mockResolvedValueOnce(rejected)
      await launch()
      mocks.adoptRunning.mockClear()
      mocks.deploy.mockResolvedValueOnce({
        outcome: 'installed-not-activated',
        fullVersion: '1.5.0+ab',
        code: 'orcad_update_terminals_running',
        reason: '2 terminals are running'
      })
      await expect(launch(undefined, { intent: 'update' })).resolves.toMatchObject({
        outcome: 'ready',
        fullVersion: '1.4.0+aa',
        deferredUpdate: { code: 'orcad_update_terminals_running', forceable: true }
      })
      expect(mocks.adoptRunning).not.toHaveBeenCalled()
      // Update still gates on incumbent terminals; only Force bypasses them.
      expect(mocks.deploy.mock.calls[1][0]).toMatchObject({ force: false, census: LIVE })
      const { admitRecord } = mocks.deploy.mock.calls[1][0]
      expect(admitRecord({ ...activeOld, rolledBackFrom: '1.5.0+ab' }, '1.5.0+ab')).toBeNull()
    })

    it('reports the rejection as is when the incumbent was not restored', async () => {
      mocks.deploy.mockResolvedValueOnce(rejected)
      mocks.transaction.mockResolvedValueOnce({ transactionId: 't1' })
      await expect(launch()).resolves.toMatchObject({
        outcome: 'deferred',
        code: 'orcad_candidate_readiness_rejected',
        reason: rejected.reason
      })
      // Unreadable host state proves no rollback restoration.
      mocks.deploy.mockResolvedValueOnce(rejected)
      mocks.transaction.mockRejectedValueOnce(new Error('wsl.exe did not answer'))
      await expect(launch(undefined, { intent: 'update' })).resolves.toMatchObject({
        outcome: 'deferred',
        code: 'orcad_candidate_readiness_rejected'
      })
      expect(mocks.adoptRunning).not.toHaveBeenCalled()
    })

    it('serves a newer host on Update rather than downgrading it, and only Force deploys', async () => {
      withRecord(newer)
      mocks.adoptRunning.mockResolvedValueOnce(adoptedAs('2.0.0+cd', NEWER_READINESS))
      await expect(launch(undefined, { intent: 'update' })).resolves.toMatchObject({
        outcome: 'ready',
        fullVersion: '2.0.0+cd'
      })
      expect(mocks.deploy).not.toHaveBeenCalled()
      mocks.adoptRunning.mockResolvedValueOnce(null)
      mocks.deploy.mockResolvedValue(policyRefused)
      await launch(undefined, { intent: 'update' })
      expect(mocks.deploy.mock.calls[0][0].admitRecord(newer, '1.5.0+ab')).toMatch(/last ran/)
      await launch(undefined, { intent: 'force' })
      expect(mocks.deploy.mock.calls[1][0]).toMatchObject({ force: true })
      expect(mocks.deploy.mock.calls[1][0].admitRecord(newer, '1.5.0+ab')).toBeNull()
    })

    it('still skips a failed build on the next connect when an explicit Update only waited', async () => {
      mocks.deploy.mockResolvedValueOnce(rejected)
      await launch()
      mocks.deploy.mockResolvedValueOnce({
        outcome: 'installed-not-activated',
        fullVersion: '1.5.0+ab',
        code: 'orcad_update_terminals_running',
        reason: 'busy'
      })
      await launch(undefined, { intent: 'update' })
      mocks.adoptRunning.mockResolvedValueOnce(adoptedAs('1.4.0+aa', INCUMBENT_READINESS))
      await expect(launch()).resolves.toMatchObject({ outcome: 'ready', fullVersion: '1.4.0+aa' })
      expect(mocks.deploy).toHaveBeenCalledTimes(2)
    })

    it('names a newer host refusal apart from a rolled-back one, so only Force is offered', async () => {
      withRecord(newer)
      mocks.adoptRunning.mockResolvedValueOnce(null)
      mocks.deploy.mockResolvedValueOnce(policyRefused)
      await expect(launch(undefined, { intent: 'update' })).resolves.toMatchObject({
        outcome: 'deferred',
        code: 'orcad_host_newer',
        forceable: true
      })
      withRecord({ ...activeOld, rolledBackFrom: '1.5.0+ab' })
      mocks.adoptRunning.mockResolvedValueOnce(null)
      mocks.deploy.mockResolvedValueOnce(policyRefused)
      await expect(launch()).resolves.toMatchObject({
        outcome: 'deferred',
        code: 'orcad_activation_policy_refused'
      })
    })

    it('keeps retrying an update that only waited, or that a newer host refused', async () => {
      mocks.deploy.mockResolvedValue({
        outcome: 'installed-not-activated',
        fullVersion: '1.5.0+ab',
        code: 'orcad_update_terminals_running',
        reason: 'busy'
      })
      await launch()
      await launch()
      mocks.deploy.mockResolvedValue(policyRefused)
      await launch()
      await launch()
      expect(mocks.deploy).toHaveBeenCalledTimes(4)
      expect(mocks.adoptRunning).not.toHaveBeenCalled()
    })

    it('lets the next connect try again once an explicit Force went through', async () => {
      mocks.deploy.mockResolvedValueOnce(rejected)
      await launch()
      mocks.deploy.mockResolvedValueOnce({
        outcome: 'installed-and-activated',
        fullVersion: '1.5.0+ab',
        verdict: {}
      })
      await launch(undefined, { intent: 'force' })
      mocks.deploy.mockResolvedValueOnce(rejected)
      await launch()
      expect(mocks.deploy).toHaveBeenCalledTimes(3)
    })

    it('deploys on the record the wake read when the skipped build stopped meanwhile', async () => {
      withRecord(newer)
      const stopped = { ...newer, active: null, activatedAt: null }
      mocks.adoptRunning.mockResolvedValueOnce(null)
      mocks.readRecord.mockResolvedValueOnce(stopped)
      mocks.deploy.mockResolvedValueOnce(policyRefused)
      await launch()
      expect(mocks.incumbent).not.toHaveBeenCalled()
      expect(mocks.deploy.mock.calls[0][0]).toMatchObject({
        censusRecord: stopped,
        census: { liveSessions: 0 }
      })
    })

    it('leaves a host stopped after a rollback for Force, not the build it rolled back from', async () => {
      // Desktop lacks the previous bundle and cannot restart it.
      const stopped = {
        ...emptyOrcadActivationRecord(),
        previous: '1.4.0+aa',
        rolledBackFrom: '1.5.0+ab'
      }
      withRecord(stopped)
      mocks.deploy.mockResolvedValueOnce(policyRefused)
      await expect(launch()).resolves.toMatchObject({ outcome: 'deferred', forceable: true })
      expect(mocks.adoptRunning).not.toHaveBeenCalled()
      expect(mocks.deploy.mock.calls[0][0].admitRecord(stopped, '1.5.0+ab')).toMatch(
        /rolled back from 1\.5\.0\+ab/
      )
    })

    it('updates an older host as before, without asking to adopt it', async () => {
      mocks.deploy.mockResolvedValueOnce({
        outcome: 'installed-and-activated',
        fullVersion: '1.5.0+ab',
        verdict: {}
      })
      await expect(launch()).resolves.toMatchObject({ outcome: 'ready', fullVersion: '1.5.0+ab' })
      expect(mocks.adoptRunning).not.toHaveBeenCalled()
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
