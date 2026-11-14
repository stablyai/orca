import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { directWire, directWireTracker } from '../../transport/rpc/direct-rpc-wire-test-harness'
import type { PRInfo } from '../../../../src/shared/github/pull-requests/pull-request-types'
import { fetchPRForBranch } from './github-pr-rpc'
import { loadPrBranchReview, type PrBranchReview } from './mobile-pr-sidebar-state'
import type { WorktreeGitHubPRLink } from './mobile-pr-link'

const pr = {
  number: 7,
  title: 'Shown PR',
  state: 'open',
  url: 'https://github.com/acme/repo/pull/7',
  checksStatus: 'success',
  updatedAt: '2026-11-01T00:00:00Z',
  mergeable: 'MERGEABLE',
  headSha: 'head-a'
} satisfies PRInfo

function phoneHost() {
  const socket = directWire()
  const tracker = directWireTracker(socket)
  const reply = (method: string, result: unknown) => {
    const frame = socket.frames().find((sent) => sent.method === method)
    tracker.resolve({ id: frame.id, ok: true, result })
  }
  const port = { sendRequest: tracker.sendRequest.bind(tracker) }
  return { socket, tracker, reply, port }
}

describe('a phone PR screen’s timer read', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('opts into revalidation, stays answerable while the host holds it, and keeps what is shown on a receipt', async () => {
    const host = phoneHost()
    const timer = fetchPRForBranch(host.port, 'repo-1::/repo', {
      branch: 'feature',
      intent: 'background'
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(host.socket.frames()[0].params).toMatchObject({
      reason: 'swr',
      acceptRevalidationOnly: true
    })

    // The host holds the timer read for its admission wait; status and actions still answer.
    const status = host.tracker.sendRequest('status.get')
    await vi.advanceTimersByTimeAsync(0)
    host.reply('status.get', { runtimeId: 'host' })
    await expect(status).resolves.toMatchObject({ ok: true })

    await vi.advanceTimersByTimeAsync(25_000)
    host.reply('github.prForBranch', { revalidation: { invalidated: true, retryAfterMs: 10_000 } })
    await expect(timer).resolves.toEqual({
      ok: true,
      result: null,
      revalidationOnly: true,
      retryAfterMs: 10_000
    })
  })

  it.each([
    ['foreground', { reason: 'active' }],
    ['open', {}]
  ] as const)('a %s read reads fresh without opting in', async (intent, expected) => {
    const host = phoneHost()
    void fetchPRForBranch(host.port, 'repo-1::/repo', { branch: 'feature', intent })
    await vi.advanceTimersByTimeAsync(0)
    const params = host.socket.frames()[0].params
    expect(params).toMatchObject(expected)
    expect(params).not.toHaveProperty('acceptRevalidationOnly')
    expect(params).not.toHaveProperty('foreground')
  })
})

describe('loadPrBranchReview with a revalidation receipt', () => {
  const previous: PrBranchReview = {
    kind: 'found',
    pr,
    pushTarget: null,
    linkedPRNumber: 7
  }
  const deps = (reply: Awaited<ReturnType<typeof fetchPRForBranch>>) => ({
    fetchForBranch: vi.fn(async () => ({ ok: true as const, result: null })),
    fetchWorktreeGitHubPRLink: vi.fn(async (): Promise<WorktreeGitHubPRLink> => ({
      linkedPR: 7,
      suppressedGitHubPR: null,
      pushTarget: null
    })),
    clearWorktreeReviewLink: vi.fn(async () => {}),
    fetchPRForBranch: vi.fn(async () => reply)
  })

  it('keeps the shown PR and its link when the host sends no answer, and asks to read again soon', async () => {
    const loader = deps({ ok: true, result: null, revalidationOnly: true, retryAfterMs: 12_000 })
    const review = await loadPrBranchReview(loader, {
      worktreeId: 'repo-1::/repo',
      branch: 'feature',
      intent: 'background',
      previous
    })
    expect(review).toEqual({ ...previous, retryAfterMs: 12_000 })
    expect(loader.clearWorktreeReviewLink).not.toHaveBeenCalled()
  })

  it.each([
    ['the link moved to another PR', 7, { linkedPR: 8, suppressedGitHubPR: null }],
    ['the shown PR is now suppressed', null, { linkedPR: null, suppressedGitHubPR: 7 }],
    ['this read unlinked the shown PR', null, { linkedPR: 7, suppressedGitHubPR: null }]
  ] as const)('does not keep the shown PR on a receipt when %s', async (_case, shownLink, link) => {
    const receipt = {
      ok: true as const,
      result: null,
      revalidationOnly: true as const,
      retryAfterMs: 12_000
    }
    const loader = deps(receipt)
    loader.fetchWorktreeGitHubPRLink.mockResolvedValue({ ...link, pushTarget: null })
    // The linked PR moved to another branch, so the read clears the link and reads by branch.
    loader.fetchPRForBranch.mockResolvedValueOnce(
      link.linkedPR === 7
        ? { ok: true, result: { ...pr, headRefName: 'other', headSha: 'head-other' } }
        : receipt
    )
    const review = await loadPrBranchReview(loader, {
      worktreeId: 'repo-1::/repo',
      branch: 'feature',
      headSha: 'head-b',
      intent: 'background',
      previous: { ...previous, linkedPRNumber: shownLink }
    })
    expect(review).toMatchObject({ kind: 'none', retryAfterMs: 12_000 })
    expect(review).not.toHaveProperty('pr')
  })

  it('shows a cached answer the host is still revalidating, then asks again soon', async () => {
    const loader = deps({ ok: true, result: { ...pr, title: 'Cached' }, retryAfterMs: 10_000 })
    expect(
      await loadPrBranchReview(loader, {
        worktreeId: 'repo-1::/repo',
        branch: 'feature',
        intent: 'background',
        previous
      })
    ).toMatchObject({ kind: 'found', pr: { title: 'Cached' }, retryAfterMs: 10_000 })
  })
})
