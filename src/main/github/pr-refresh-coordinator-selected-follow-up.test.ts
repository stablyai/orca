import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { getPRForBranchOutcomeMock } = coordinatorMocks

const SELECTED_BRANCH = 'feature/selected'

function listCards(count: number) {
  return Array.from({ length: count }, (_, index) =>
    makeCandidate({
      cacheKey: `/repo::feature/${index}`,
      branch: `feature/${index}`,
      worktreeId: `wt-${index}`
    })
  )
}

const selectedCard = makeCandidate({
  cacheKey: `/repo::${SELECTED_BRANCH}`,
  branch: SELECTED_BRANCH,
  worktreeId: 'wt-selected',
  isSelected: true
})

async function advance(ms: number): Promise<void> {
  // Step in small slices so every drain timer fires in order.
  for (let elapsed = 0; elapsed < ms; elapsed += 10_000) {
    await vi.advanceTimersByTimeAsync(Math.min(10_000, ms - elapsed))
  }
}

function readTimes(branch: string, since: number): number[] {
  return readLog.filter((read) => read.branch === branch && read.at >= since).map((r) => r.at)
}

const readLog: { branch: string; at: number }[] = []

describe('selected workspace follow-ups under a busy sidebar', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'))
    readLog.length = 0
    getPRForBranchOutcomeMock.mockImplementation(async (_repo: string, branch: string) => {
      readLog.push({ branch, at: Date.now() })
      return {
        kind: 'found',
        pr: makePR({ checksStatus: 'success', state: 'open' }),
        fetchedAt: Date.now()
      }
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it(
    'reads the selected open PR about every minute while 25 other open-PR cards are visible',
    async () => {
      const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
      // No foreground enqueue: the workspace was selected while its cached PR was still fresh.
      reportVisiblePRRefreshCandidates([...listCards(25), selectedCard], 1, 1)
      await advance(10 * 60_000)
      const steadyStart = Date.now()
      await advance(10 * 60_000)

      const times = readTimes(SELECTED_BRANCH, steadyStart)
      const gaps = times.slice(1).map((at, index) => at - times[index])
      // The list budget can hold a ready read back for one burst gap, never for minutes.
      expect(times.length).toBeGreaterThanOrEqual(6)
      expect(Math.max(...gaps)).toBeLessThanOrEqual(140_000)
    },
    // Twenty simulated minutes of drain timers take a few real seconds under load.
    60_000
  )

  it(
    'puts a deselected workspace back in list order after its next read',
    async () => {
      const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
      const cards = listCards(25)
      reportVisiblePRRefreshCandidates([...cards, selectedCard], 1, 1)
      await advance(10 * 60_000)
      // Select a list card instead; the old selection becomes an ordinary card.
      const nowSelected = { ...cards[0], isSelected: true }
      const formerlySelected = { ...selectedCard, isSelected: false }
      reportVisiblePRRefreshCandidates([nowSelected, ...cards.slice(1), formerlySelected], 2, 1)
      await advance(5 * 60_000)
      const steadyStart = Date.now()
      await advance(10 * 60_000)

      const former = readTimes(SELECTED_BRANCH, steadyStart)
      const current = readTimes(cards[0].branch, steadyStart)
      expect(current.length).toBeGreaterThan(former.length * 2)
    },
    // Twenty simulated minutes of drain timers take a few real seconds under load.
    60_000
  )
})
