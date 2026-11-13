import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makePR } from '../../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type { VisibleHostedReviewRefreshTarget as Target } from '../../../../renderer/src/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'
import type { RuntimeHostedReviewCommands } from './runtime-hosted-review-commands'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), account: vi.fn(), gate: vi.fn() }))
vi.mock('../../../github/accounts/github-project-account', () => ({
  githubPRPolicyProjects: () => ({ source: null, selection: String(mocks.account()) }),
  resolveGitHubProjectAccount: mocks.account
}))
vi.mock('../../../github/execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))
vi.mock('../../../github/client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: mocks.resolve
}))
vi.mock('../../../github/pull-requests/refresh/pr-refresh-rate-limit-gate', () => ({
  prRefreshRateLimitPausedUntil: mocks.gate
}))

let commands: RuntimeHostedReviewCommands
let title = 'before'
const found = (): PRRefreshOutcome => ({
  kind: 'found',
  fetchedAt: Date.now(),
  pr: makePR({
    title,
    headSha: 'head-a',
    checksStatus: 'success',
    checksReadComplete: true,
    checksFinal: true,
    autoMergeEnabled: false,
    mergeQueueRequired: false
  })
})
const read = async (
  branch: string,
  reason: 'active' | 'visible' | 'swr' | 'manual' = 'swr',
  head = 'head-a'
): Promise<PRRefreshOutcome> => {
  const reply = await commands.getRepoPRForBranch(
    'repo',
    branch,
    null,
    null,
    false,
    head,
    reason,
    undefined,
    undefined,
    undefined,
    true
  )
  if (!('kind' in reply)) {
    throw new Error('Stable benchmark ownership was invalidated')
  }
  return reply
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  title = 'before'
  mocks.resolve.mockReset().mockImplementation(async () => found())
  mocks.account.mockReset().mockReturnValue(null)
  mocks.gate.mockReset().mockResolvedValue(null)
  const { RuntimeHostedReviewCommands: Commands } = await import('./runtime-hosted-review-commands')
  const repo = {
    id: 'repo',
    path: '/repo',
    kind: 'git' as const,
    displayName: 'repo',
    badgeColor: 'blue',
    addedAt: 0
  }
  commands = new Commands({
    resolveRepo: async () => repo,
    resolveTarget: async () => ({ repo, repoPath: repo.path }),
    getExecutionOptions: () => undefined,
    recordCreated: () => {}
  })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it.each([
  { rows: 14, clients: 2 },
  { rows: 14, clients: 20 },
  { rows: 140, clients: 2 }
])(
  'bounds shared polling for $rows rows and $clients clients over thirty minutes',
  async ({ rows, clients }) => {
    const { createVisibleHostedReviewRefreshScheduler } =
      await import('../../../../renderer/src/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler')
    const start = Date.now()
    const spans: { branch: string; startedAt: number; completedAt: number }[] = []
    const deliveries: number[] = []
    const admissionDelays: number[] = []
    const pendingDemand = new Map<string, number>()
    const settledAt: number[] = []
    let requests = 0
    let receipts = 0
    mocks.resolve.mockImplementation(async ({ branchName }) => {
      const startedAt = Date.now()
      const demand = pendingDemand.get(branchName)
      if (demand !== undefined) {
        admissionDelays.push(startedAt - demand)
      }
      pendingDemand.delete(branchName)
      // ast-grep-ignore: test-no-real-time-wait -- Fake-clock provider delay exercises host admission and completion.
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      const pending = Number(branchName.slice(4)) < 2 && Date.now() - start < 600_000
      const outcome: PRRefreshOutcome = {
        kind: 'found',
        fetchedAt: Date.now(),
        pr: makePR({
          title: pending ? 'running' : 'settled',
          headSha: 'head-a',
          checksStatus: pending ? 'pending' : 'success',
          checksReadComplete: true,
          checksFinal: !pending,
          autoMergeEnabled: false,
          mergeQueueRequired: false
        })
      }
      spans.push({ branch: branchName, startedAt, completedAt: Date.now() })
      return outcome
    })
    const warm = Promise.all(Array.from({ length: rows }, (_, i) => read(`row-${i}`, 'active')))
    await vi.advanceTimersByTimeAsync(1_000)
    const initial = await warm
    const schedulers = Array.from({ length: clients }, (_, client) => {
      const scheduler = createVisibleHostedReviewRefreshScheduler()
      const cache = initial.map((outcome) => outcome.fetchedAt)
      const delivered = new Set(initial.map((outcome, row) => `${row}:${outcome.fetchedAt}`))
      const sawSettled = new Set<number>()
      const targets = (): Target[] =>
        cache.map((fetchedAt, row) => ({
          key: `row-${row}`,
          revision: 'head-a',
          fetchedAt,
          intervalMs: row === 0 ? 60_000 : 120_000,
          selected: row === 0,
          refresh: async (_force, signal, intent) => {
            requests += 1
            const branch = `row-${row}`
            if (!pendingDemand.has(branch)) {
              pendingDemand.set(branch, Date.now())
            }
            const outcome = await commands.getRepoPRForBranch(
              'repo',
              `row-${row}`,
              null,
              null,
              false,
              'head-a',
              intent === 'discovery' ? 'active' : 'swr',
              false,
              undefined,
              signal,
              true
            )
            if (!('kind' in outcome)) {
              throw new Error('Stable benchmark ownership was invalidated')
            }
            if (outcome.kind !== 'upstream-error') {
              cache[row] = outcome.fetchedAt
              if (outcome.revalidation) {
                receipts += 1
              } else {
                pendingDemand.delete(branch)
                const completion = `${row}:${outcome.fetchedAt}`
                if (!delivered.has(completion)) {
                  delivered.add(completion)
                  deliveries.push(Date.now() - outcome.fetchedAt)
                }
                if (
                  outcome.kind === 'found' &&
                  row < 2 &&
                  outcome.pr.title === 'settled' &&
                  !sawSettled.has(row)
                ) {
                  sawSettled.add(row)
                  settledAt.push(Date.now() - start - 600_000)
                }
              }
              scheduler.update(targets())
            }
            return {
              succeeded: outcome.kind !== 'upstream-error',
              retryAfterMs: outcome.revalidation?.retryAfterMs
            }
          }
        }))
      scheduler.update(targets())
      setTimeout(() => scheduler.setVisible(true), (client % 2) * 5_000)
      return scheduler
    })
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    for (const scheduler of schedulers) {
      scheduler.dispose()
    }
    const atHide = spans.length
    await vi.advanceTimersByTimeAsync(6 * 60_000)
    const drained = spans.length
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(spans.length).toBe(drained)
    // Timers share one twenty-start/five-minute budget, independent of client multiplicity.
    const timed = spans.slice(rows)
    for (const span of timed) {
      expect(
        timed.filter(
          (other) => other.startedAt > span.startedAt - 300_000 && other.startedAt <= span.startedAt
        ).length
      ).toBeLessThanOrEqual(20)
    }
    expect(timed.length).toBeLessThanOrEqual(140)
    expect(
      spans.some((span) => span.branch === 'row-0' && span.completedAt - start >= 600_000)
    ).toBe(true)
    console.info(
      'SERVE_PR_BENCH',
      JSON.stringify({
        clients,
        rows,
        simulatedMinutes: 30,
        providerReads: spans.length,
        atHide,
        drainedAfterHide: drained - atHide,
        snapshotRequests: requests,
        deferredReceipts: receipts,
        maxProviderMs: Math.max(...spans.map((s) => s.completedAt - s.startedAt)),
        maxCompletionToFirstClientApplicationMs: Math.max(0, ...deliveries),
        maxAdmissionDelayMs: Math.max(0, ...admissionDelays),
        settledRunningRowsApplied: settledAt.length,
        maxCiFinishToApplicationMs: Math.max(0, ...settledAt)
      })
    )
  },
  60_000
)
