import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DescendantSnapshot } from '../pty-descendant-termination'
import type { DescendantTreeVerdict } from '../pty-descendant-exit-verification'
import type { RetiredMacDaemonJob } from './macos-retired-daemon-jobs'
import type { ProcessIdentity } from './daemon-process-identity-query'
import type { SocketProbeOutcome } from './daemon-endpoint-probe'

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
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ isPackaged: () => mocks.packaged, getPath: () => '/profile' })
}))
vi.mock('../pty-descendant-termination', () => ({ captureDescendantSnapshot: mocks.capture }))
vi.mock('./macos-retired-daemon-jobs', () => ({
  listMacDaemonJobVersions: mocks.versions,
  readMacDaemonRecoveryJob: mocks.job
}))
vi.mock('./daemon-endpoint-probe', () => ({
  endpointIsProvenDead: (outcome: string) => outcome === 'missing' || outcome === 'refused',
  probeSocketConnect: mocks.probe
}))
vi.mock('./daemon-process-identity-query', () => ({ getPsProcessIdentityAsync: mocks.identity }))
vi.mock('./terminal-descendant-shutdown', () => ({ terminateShutdownDescendants: mocks.terminate }))
vi.mock('./macos-daemon-job-state', () => ({ releaseMacDaemonJob: mocks.release }))
import {
  recoverRetiredMacDaemonJob,
  recoverRetiredMacDaemonJobs
} from './macos-retired-daemon-recovery'

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

it('releases retired old-protocol conversation owners before returning from Restart', async () => {
  mocks.identity
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(null)
  await recoverRetiredMacDaemonJobs('/profile/daemon')
  expect(mocks.terminate).toHaveBeenCalledExactlyOnceWith(snapshot)
  expect(kill.mock.calls).toEqual([[job.pid, 'SIGKILL']])
  expect(mocks.terminate.mock.invocationCallOrder[0]).toBeLessThan(kill.mock.invocationCallOrder[0])
  expect(mocks.release).toHaveBeenCalledExactlyOnceWith(job.service, Date.now() + 3_000)
  expect(mocks.versions).toHaveBeenCalledOnce()
  expect(mocks.capture).toHaveBeenCalledOnce()
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

it.each([null, { ...identity, startedAtMs: identity.startedAtMs + 59_000 }])(
  'preserves uninspectable or newly starting processes: %j',
  async (value) => {
    mocks.identity.mockResolvedValue(value)
    await recoverRetiredMacDaemonJobs('/profile/daemon')
    expect(kill).not.toHaveBeenCalled()
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

it('accepts a root that exits naturally after its descendants', async () => {
  mocks.identity
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(identity)
    .mockResolvedValueOnce(null)
  kill.mockImplementation(() => {
    throw Object.assign(new Error('gone'), { code: 'ESRCH' })
  })
  await recoverRetiredMacDaemonJobs('/profile/daemon')
  expect(kill.mock.calls).toEqual([[job.pid, 0]])
  expect(mocks.release).toHaveBeenCalledOnce()
})

it.each(['linux', 'win32'] as const)('does no discovery on %s', async (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  await recoverRetiredMacDaemonJobs('/profile/daemon')
  expect(mocks.versions).not.toHaveBeenCalled()
})

it('does no discovery for Node/SSH execution hosts or unpackaged builds', async () => {
  Object.defineProperty(process, 'type', { configurable: true, value: undefined })
  await recoverRetiredMacDaemonJobs('/profile/daemon')
  Object.defineProperty(process, 'type', { configurable: true, value: 'browser' })
  mocks.packaged = false
  await recoverRetiredMacDaemonJobs('/profile/daemon')
  expect(mocks.versions).not.toHaveBeenCalled()
})

it('reports whether a launch-blocking label was released, reading only that protocol', async () => {
  await expect(recoverRetiredMacDaemonJob('/profile', '/profile/daemon', 45)).resolves.toBe(true)
  expect(mocks.job).toHaveBeenCalledWith('/profile', '/profile/daemon', 45)
  expect(mocks.versions).not.toHaveBeenCalled()
  expect(kill.mock.calls).toEqual([[job.pid, 'SIGKILL']])
  expect(mocks.release).toHaveBeenCalledOnce()
})

it.each([
  ['no matching job', () => mocks.job.mockResolvedValue(null)],
  ['a live endpoint', () => mocks.probe.mockResolvedValue('connected')],
  ['an unreadable endpoint', () => mocks.probe.mockResolvedValue('unknown')],
  ['a published PID record', () => mocks.stat.mockResolvedValue({})]
])('leaves a launch-blocking label alone for %s', async (_, arrange) => {
  arrange()
  await expect(recoverRetiredMacDaemonJob('/profile', '/profile/daemon', 45)).resolves.toBe(false)
  expect(kill).not.toHaveBeenCalled()
  expect(mocks.release).not.toHaveBeenCalled()
})
