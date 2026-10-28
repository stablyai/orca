import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'
import type * as WslUncAccessGate from '../wsl/wsl-unc-access-gate'
import { RepoRefMaintenance } from '../../shared/repo-ref-maintenance'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../wsl/wsl-unc-access-gate'

const mocks = vi.hoisted(() => ({
  gitExecFileAsync: vi.fn(),
  assertWslUncPathRunning: vi.fn()
}))
vi.mock('./runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  gitExecFileAsync: mocks.gitExecFileAsync
}))
vi.mock('../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslUncAccessGate>()),
  assertWslUncPathRunning: mocks.assertWslUncPathRunning,
  // Off Windows no path maps to a distro; stand in for the WSL repo's UNC root.
  wslDistroForPath: (path: string) => (path.startsWith('\\\\wsl.localhost\\') ? 'Ubuntu' : null)
}))

import { createLocalRepoRefMaintenanceTarget } from './local-repo-ref-maintenance'

const QUIET_MS = 1000
const WSL_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const engines: RepoRefMaintenance[] = []

function createHarness(repoPath = WSL_REPO) {
  const maintenance = new RepoRefMaintenance({
    quietPeriodMs: QUIET_MS,
    onError: () => {},
    observe: (attempt) => attempt({ setAttribute: () => {} })
  })
  engines.push(maintenance)
  const maintainPackIndex = vi.fn(async () => {})
  const resolveRefsDirectory = vi.fn(async () => undefined)
  const packRefs = vi.fn(async () => {})
  const target = {
    ...createLocalRepoRefMaintenanceTarget({ key: `local::${repoPath}`, repoPath }),
    maintainPackIndex,
    resolveRefsDirectory,
    packRefs
  }
  return { maintenance, target, maintainPackIndex, resolveRefsDirectory, packRefs }
}

async function elapse(maintenance: RepoRefMaintenance, milliseconds: number) {
  await vi.advanceTimersByTimeAsync(milliseconds)
  await maintenance.whenAttemptSettled()
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.gitExecFileAsync.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  mocks.assertWslUncPathRunning.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  for (const engine of engines.splice(0)) {
    engine.dispose()
  }
  vi.useRealTimers()
})

describe('ref maintenance on a stopped WSL distro (E9)', () => {
  it('runs no Git while the distro is stopped, and maintains once it runs again', async () => {
    mocks.assertWslUncPathRunning.mockRejectedValueOnce(new WslDistroStoppedError('Ubuntu'))
    const h = createHarness()
    h.maintenance.arm(h.target)
    await elapse(h.maintenance, QUIET_MS)

    expect(mocks.assertWslUncPathRunning).toHaveBeenCalledWith(WSL_REPO, undefined)
    expect(mocks.gitExecFileAsync).not.toHaveBeenCalled()
    expect(h.maintainPackIndex).not.toHaveBeenCalled()
    expect(h.resolveRefsDirectory).not.toHaveBeenCalled()
    expect(h.packRefs).not.toHaveBeenCalled()

    // The refusal retries like a failed probe; the distro runs by then.
    await elapse(h.maintenance, 2 * QUIET_MS)
    expect(mocks.gitExecFileAsync).toHaveBeenCalledTimes(1)
    expect(h.maintainPackIndex).toHaveBeenCalledTimes(1)
  })

  it('treats an unverifiable distro as blocked too', async () => {
    mocks.assertWslUncPathRunning.mockRejectedValueOnce(new WslDistroUnverifiableError('Ubuntu'))
    const h = createHarness()
    h.maintenance.arm(h.target)
    await elapse(h.maintenance, QUIET_MS)
    expect(mocks.gitExecFileAsync).not.toHaveBeenCalled()
    expect(h.maintainPackIndex).not.toHaveBeenCalled()
  })

  it('never asks the gate for a host repo', async () => {
    const h = createHarness('C:/repos/one')
    h.maintenance.arm(h.target)
    await elapse(h.maintenance, QUIET_MS)
    expect(mocks.assertWslUncPathRunning).not.toHaveBeenCalled()
    expect(mocks.gitExecFileAsync).toHaveBeenCalledTimes(1)
  })

  it('maintains a running distro exactly as before', async () => {
    const h = createHarness()
    h.maintenance.arm(h.target)
    await elapse(h.maintenance, QUIET_MS)
    expect(mocks.gitExecFileAsync).toHaveBeenCalledTimes(1)
    expect(h.maintainPackIndex).toHaveBeenCalledTimes(1)
    expect(h.resolveRefsDirectory).toHaveBeenCalledTimes(1)
  })
})
