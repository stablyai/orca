import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WslUncAccessGateModule from '../wsl/wsl-unc-access-gate'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})
const gate = vi.hoisted(() => ({
  stopped: true,
  blockedWslDistroForPath: vi.fn(),
  wslDistroForPath: vi.fn()
}))

vi.mock('electron', () => moduleMocks.electronModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))
vi.mock('../ipc/ui', () => moduleMocks.ipcUiModuleMock(coordinatorMocks))
vi.mock('../wsl/wsl-unc-access-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof WslUncAccessGateModule>()),
  blockedWslDistroForPath: gate.blockedWslDistroForPath,
  wslDistroForPath: gate.wslDistroForPath
}))

import { makeCandidate } from './pr-refresh-coordinator-test-harness'

const { getPRForBranchOutcomeMock } = coordinatorMocks
const WSL_REPO = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

describe('PR refresh for a stopped WSL distro (E9)', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: 1 })
    gate.blockedWslDistroForPath.mockReset()
    gate.wslDistroForPath.mockReset()
    gate.wslDistroForPath.mockImplementation((path: string) =>
      path.startsWith('\\\\wsl.localhost\\') ? 'Ubuntu' : null
    )
    gate.blockedWslDistroForPath.mockImplementation(async () =>
      gate.stopped ? { distro: 'Ubuntu', state: 'stopped' } : null
    )
  })

  afterEach(() => {
    gate.stopped = true
    vi.useRealTimers()
  })

  it("drains outside a user act that scheduled it, so a stopped distro's queue is not admitted", async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const { isWslUserActFor, runAsWslUserAct } = await import('../wsl/wsl-user-act-scope')
    const drainedInsideAct: boolean[] = []
    gate.blockedWslDistroForPath.mockImplementation(async () => {
      drainedInsideAct.push(isWslUserActFor('Ubuntu'))
      return { distro: 'Ubuntu', state: 'stopped' }
    })
    const candidate = makeCandidate({
      repoPath: WSL_REPO,
      cacheKey: `${WSL_REPO}::feature/act`,
      isSelected: true
    })

    // The drain timer is armed and fires while the act still holds.
    await runAsWslUserAct('Ubuntu', async () => {
      reportVisiblePRRefreshCandidates([candidate], 1, 1)
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(drainedInsideAct).toEqual([false])
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })
})
