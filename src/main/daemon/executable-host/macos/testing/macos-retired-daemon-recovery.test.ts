import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DescendantSnapshot } from '../../../../pty/process-retirement/pty-descendant-termination'
import type { DescendantTreeVerdict } from '../../../../pty/process-retirement/pty-descendant-exit-verification'
import type { RetiredMacDaemonJob } from '../macos-retired-daemon-jobs'
import type { ProcessIdentity } from '../../../endpoint/identity/daemon-process-identity-query'
import type { SocketProbeOutcome } from '../../../endpoint/publication/daemon-endpoint-probe'

const mocks = vi.hoisted(() => ({
  packaged: true,
  stat: vi.fn(),
  versions: vi.fn<() => Promise<number[]>>(),
  job: vi.fn<() => Promise<RetiredMacDaemonJob | null>>(),
  probe: vi.fn<() => Promise<SocketProbeOutcome>>(),
  identity: vi.fn<() => Promise<ProcessIdentity | null>>(),
  capture: vi.fn<() => Promise<DescendantSnapshot | null>>(),
  terminate: vi.fn<() => Promise<DescendantTreeVerdict>>(),
  release: vi.fn<() => Promise<boolean>>()
}))
vi.mock('node:fs/promises', () => ({ lstat: mocks.stat }))
vi.mock('../../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ isPackaged: () => mocks.packaged, getPath: () => '/profile' })
}))
vi.mock('../../../../pty/process-retirement/pty-descendant-termination', () => ({
  captureDescendantSnapshot: mocks.capture
}))
vi.mock('../macos-retired-daemon-jobs', () => ({
  listMacDaemonJobVersions: mocks.versions,
  readMacDaemonRecoveryJob: mocks.job
}))
vi.mock('../../../endpoint/publication/daemon-endpoint-probe', () => ({
  endpointIsProvenDead: (outcome: string) => outcome === 'missing' || outcome === 'refused',
  probeSocketConnect: mocks.probe
}))
vi.mock('../../../endpoint/identity/daemon-process-identity-query', () => ({
  getPsProcessIdentityAsync: mocks.identity
}))
vi.mock('../../../sessions/terminal-descendant-shutdown', () => ({
  terminateShutdownDescendants: mocks.terminate
}))
vi.mock('../macos-daemon-job-state', () => ({ releaseMacDaemonJob: mocks.release }))
import { recoverRetiredMacDaemonJobs } from '../macos-retired-daemon-recovery'

const startedAt = 'Mon Oct 12 16:28:32 2026'
const identity = { commandLine: 'daemon', startedAtMs: Date.parse(startedAt) }
const job: RetiredMacDaemonJob = {
  service: 'gui/501/profile.v45',
  protocolVersion: 45,
  pid: 7621,
  launchNonce: 'old',
  socketPath: '/profile/daemon/v45.sock',
  pidPath: '/profile/daemon/v45.pid'
}
const snapshot: DescendantSnapshot = {
  root: { pid: job.pid, startedAt },
  rootPgid: job.pid,
  descendants: [{ pid: 88912, ppid: job.pid, pgid: 88912, startedAt }],
  capturedAtMs: Date.parse(startedAt) + 60_000
}
const typeDescriptor = Object.getOwnPropertyDescriptor(process, 'type')
const kill = vi.fn<typeof process.kill>()

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  Object.defineProperty(process, 'type', { configurable: true, value: 'browser' })
  vi.spyOn(Date, 'now').mockReturnValue(identity.startedAtMs + 60_000)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  kill.mockReturnValue(true)
  vi.spyOn(process, 'kill').mockImplementation(kill)
  mocks.packaged = true
  mocks.stat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }))
  mocks.versions.mockResolvedValue([45])
  mocks.job.mockResolvedValue(job)
  mocks.probe.mockResolvedValue('refused')
  mocks.identity.mockResolvedValue(identity)
  mocks.capture.mockResolvedValue(snapshot)
  mocks.terminate.mockResolvedValue('exited')
  mocks.release.mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (typeDescriptor) {
    Object.defineProperty(process, 'type', typeDescriptor)
  } else {
    Reflect.deleteProperty(process, 'type')
  }
})

it.each(['connected', 'unknown'] as const)('preserves endpoints that read %s', async (outcome) => {
  mocks.probe.mockResolvedValue(outcome)
  await recoverRetiredMacDaemonJobs('/profile/daemon')
  expect(kill).not.toHaveBeenCalled()
  expect(mocks.capture).not.toHaveBeenCalled()
})

it.each(['present', 'permission-denied'] as const)(
  'preserves non-retired PID records: %s',
  async (state) => {
    if (state === 'present') {
      mocks.stat.mockResolvedValue({})
    } else {
      mocks.stat.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }))
    }
    await recoverRetiredMacDaemonJobs('/profile/daemon')
    expect(kill).not.toHaveBeenCalled()
    expect(mocks.probe).not.toHaveBeenCalled()
  }
)

it('never signals a reused root PID or a replacement service', async () => {
  mocks.job.mockResolvedValueOnce(job).mockResolvedValueOnce({ ...job, launchNonce: 'new' })
  await recoverRetiredMacDaemonJobs('/profile/daemon')
  expect(kill).not.toHaveBeenCalled()
  mocks.job.mockResolvedValue(job)
  mocks.identity
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce({ ...identity, startedAtMs: 1 })
  await recoverRetiredMacDaemonJobs('/profile/daemon')
  expect(kill).not.toHaveBeenCalled()
})

it('signals nothing and refuses success when process-table capture fails', async () => {
  mocks.capture.mockResolvedValue(null)
  await expect(recoverRetiredMacDaemonJobs('/profile/daemon')).rejects.toThrow('Could not verify')
  expect(kill).not.toHaveBeenCalled()
  expect(mocks.terminate).not.toHaveBeenCalled()
})

it('rechecks retirement after capturing the descendant tree', async () => {
  mocks.probe.mockResolvedValueOnce('refused').mockResolvedValueOnce('connected')
  await expect(recoverRetiredMacDaemonJobs('/profile/daemon')).rejects.toThrow('Could not verify')
  expect(mocks.terminate).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
})

it('never sweeps a snapshot naming another root incarnation', async () => {
  mocks.capture.mockResolvedValue({
    ...snapshot,
    root: { pid: job.pid, startedAt: 'Tue Oct 13 16:28:32 2026' }
  })
  await expect(recoverRetiredMacDaemonJobs('/profile/daemon')).rejects.toThrow('Could not verify')
  expect(mocks.terminate).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
})

it('preserves a service that republishes its PID record during inspection', async () => {
  mocks.stat
    .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    .mockResolvedValue({})
  await expect(recoverRetiredMacDaemonJobs('/profile/daemon')).rejects.toThrow('Could not verify')
  expect(mocks.terminate).not.toHaveBeenCalled()
  expect(kill).not.toHaveBeenCalled()
})

it.each(['live', 'unverifiable'] as const)(
  'fails closed when descendants are %s',
  async (verdict) => {
    mocks.terminate.mockResolvedValue(verdict)
    await expect(recoverRetiredMacDaemonJobs('/profile/daemon')).rejects.toThrow(verdict)
    expect(kill).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  }
)

it('never signals a root recycled during descendant teardown', async () => {
  mocks.identity
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(identity)
    .mockResolvedValue({ ...identity, startedAtMs: 1 })
  await expect(recoverRetiredMacDaemonJobs('/profile/daemon')).rejects.toThrow('changed')
  expect(kill.mock.calls).toEqual([[job.pid, 0]])
  expect(mocks.release).not.toHaveBeenCalled()
})

it('does not report success while a service registration remains', async () => {
  mocks.release.mockResolvedValue(false)
  await expect(recoverRetiredMacDaemonJobs('/profile/daemon')).rejects.toThrow('Could not release')
})
