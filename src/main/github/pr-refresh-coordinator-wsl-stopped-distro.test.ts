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

vi.mock('../runtime/runtime-desktop-surface', () =>
  moduleMocks.runtimeDesktopSurfaceModuleMock(coordinatorMocks)
)
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))
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

  it('skips a queued background refresh without running gh, and refreshes once it runs', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const candidate = makeCandidate({
      repoPath: WSL_REPO,
      cacheKey: `${WSL_REPO}::feature/test`,
      isSelected: true
    })

    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
    expect(gate.blockedWslDistroForPath).toHaveBeenCalledWith(WSL_REPO, undefined)

    gate.stopped = false
    reportVisiblePRRefreshCandidates([candidate], 2, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it.each(['visible', 'active', 'post-push'] as const)(
    'skips an automatic %s refreshPRNow without running gh, keeping the cached PR',
    async (reason) => {
      const { refreshPRNow } = await import('./pr-refresh-coordinator')
      const outcome = await refreshPRNow(
        makeCandidate({ repoPath: WSL_REPO, cacheKey: `${WSL_REPO}::c` }),
        reason
      )
      expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
      expect(outcome).toMatchObject({ kind: 'upstream-error' })
    }
  )

  it('treats an unverifiable distro as blocked', async () => {
    gate.blockedWslDistroForPath.mockResolvedValue({ distro: 'Ubuntu', state: 'unverifiable' })
    const { refreshPRNow } = await import('./pr-refresh-coordinator')
    await refreshPRNow(makeCandidate({ repoPath: WSL_REPO, cacheKey: `${WSL_REPO}::d` }), 'visible')
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
  })

  it('still runs a manual refresh, which is the user asking', async () => {
    const { refreshPRNow } = await import('./pr-refresh-coordinator')
    await refreshPRNow(makeCandidate({ repoPath: WSL_REPO, cacheKey: `${WSL_REPO}::b` }))
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('refreshes a host repo exactly as before, without asking the gate', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    reportVisiblePRRefreshCandidates([makeCandidate({ isSelected: true })], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(gate.blockedWslDistroForPath).not.toHaveBeenCalled()
  })
})
