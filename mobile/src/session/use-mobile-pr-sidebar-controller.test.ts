import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItemDetails, PRCheckDetail, PRInfo } from '../../../src/shared/types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import type { GitHubPrReadOutcome } from './github-pr-rpc'
import {
  classifyPrSidebarFailure,
  loadPrSidebarData,
  loadPrSidebarDetails,
  shouldApplyResult,
  type PrSidebarLoadDeps
} from './mobile-pr-sidebar-state'

function ok<T>(result: T): GitHubPrReadOutcome<T> {
  return { ok: true, result }
}
function fail<T>(error: string): GitHubPrReadOutcome<T> {
  return { ok: false, error }
}

const PR: PRInfo = {
  number: 7,
  title: 'Feat',
  state: 'open',
  url: 'u',
  checksStatus: 'success',
  updatedAt: 'now',
  mergeable: 'MERGEABLE',
  reviewDecision: null,
  headSha: 'sha-pr'
} as unknown as PRInfo
const DETAILS = { item: { number: 7 }, checks: [] } as unknown as GitHubWorkItemDetails
const CHECKS: PRCheckDetail[] = [
  { name: 'ci', status: 'completed', conclusion: 'success', url: null }
]

function ghInfo(over: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 7,
    title: 'Feat',
    state: 'open',
    url: 'u',
    status: 'success',
    updatedAt: 'now',
    mergeable: 'MERGEABLE',
    ...over
  } as HostedReviewInfo
}

describe('classifyPrSidebarFailure', () => {
  it('routes permission/auth messages to blocked', () => {
    expect(classifyPrSidebarFailure('permission denied')).toBe('blocked')
    expect(classifyPrSidebarFailure('GitHub account not connected')).toBe('blocked')
    expect(classifyPrSidebarFailure('HTTP 403 Forbidden')).toBe('blocked')
    expect(classifyPrSidebarFailure('401 Unauthorized')).toBe('blocked')
  })

  it('routes network/transient messages to error', () => {
    expect(classifyPrSidebarFailure('network timeout')).toBe('error')
    expect(classifyPrSidebarFailure('socket hang up')).toBe('error')
  })
})

describe('loadPrSidebarData', () => {
  function deps(over: Partial<PrSidebarLoadDeps> = {}): PrSidebarLoadDeps {
    return {
      fetchForBranch: vi.fn(async () => ok<HostedReviewInfo | null>(ghInfo())),
      fetchWorktreeLinkedPR: vi.fn(async () => null),
      fetchPRForBranch: vi.fn(async () => ok<PRInfo | null>(PR)),
      fetchWorkItemDetails: vi.fn(async () => ok<GitHubWorkItemDetails | null>(DETAILS)),
      fetchPRChecks: vi.fn(async () => ok<PRCheckDetail[]>(CHECKS)),
      ...over
    }
  }

  it('phase 1 loads pr + checks into ready with details=null (comments deferred)', async () => {
    const d = deps()
    const out = await loadPrSidebarData(d, {
      worktreeId: 'w',
      branch: 'feat',
      headSha: 'sha-status'
    })
    expect(out).toEqual({ kind: 'ready', data: { pr: PR, details: null, checks: CHECKS } })
    // Details (heavy comments payload) are NOT fetched on the critical path.
    expect(d.fetchWorkItemDetails).not.toHaveBeenCalled()
    // forBranch's PR number is threaded into prForBranch as the linked hint.
    expect(d.fetchPRForBranch).toHaveBeenCalledWith('w', { branch: 'feat', linkedPRNumber: 7 })
    // headSha forwarded to checks (status SHA wins over pr.headSha).
    expect(d.fetchPRChecks).toHaveBeenCalledWith('w', {
      prNumber: 7,
      headSha: 'sha-status',
      prRepo: null
    })
  })

  it('passes a null hint when forBranch and the worktree linkedPR are both empty', async () => {
    const d = deps({ fetchForBranch: vi.fn(async () => ok<HostedReviewInfo | null>(null)) })
    await loadPrSidebarData(d, { worktreeId: 'w', branch: 'feat' })
    expect(d.fetchPRForBranch).toHaveBeenCalledWith('w', { branch: 'feat', linkedPRNumber: null })
  })

  it('falls back to the worktree linkedPR when forBranch has no open PR (closed/merged)', async () => {
    const merged = { ...PR, number: 42, state: 'merged' } as unknown as PRInfo
    const d = deps({
      fetchForBranch: vi.fn(async () => ok<HostedReviewInfo | null>(null)),
      fetchWorktreeLinkedPR: vi.fn(async () => 42),
      fetchPRForBranch: vi.fn(async () => ok<PRInfo | null>(merged))
    })
    const out = await loadPrSidebarData(d, { worktreeId: 'w', branch: 'feat' })
    expect(d.fetchPRForBranch).toHaveBeenCalledWith('w', { branch: 'feat', linkedPRNumber: 42 })
    expect(out).toEqual({ kind: 'ready', data: { pr: merged, details: null, checks: CHECKS } })
  })

  it('prefers the forBranch open hint over the worktree linkedPR', async () => {
    const d = deps({ fetchWorktreeLinkedPR: vi.fn(async () => 42) })
    await loadPrSidebarData(d, { worktreeId: 'w', branch: 'feat' })
    expect(d.fetchPRForBranch).toHaveBeenCalledWith('w', { branch: 'feat', linkedPRNumber: 7 })
  })

  it('does not pass non-GitHub hosted-review hints into the GitHub PR lookup', async () => {
    const d = deps({
      fetchForBranch: vi.fn(async () =>
        ok<HostedReviewInfo | null>(ghInfo({ provider: 'gitlab', number: 99 }))
      ),
      fetchWorktreeLinkedPR: vi.fn(async () => null)
    })
    await loadPrSidebarData(d, { worktreeId: 'w', branch: 'feat' })
    expect(d.fetchPRForBranch).toHaveBeenCalledWith('w', { branch: 'feat', linkedPRNumber: null })
  })

  it('is non-fatal when forBranch errors — prForBranch still resolves', async () => {
    const d = deps({ fetchForBranch: vi.fn(async () => fail<HostedReviewInfo | null>('timeout')) })
    const out = await loadPrSidebarData(d, { worktreeId: 'w', branch: 'feat' })
    expect(out.kind).toBe('ready')
  })

  it('returns the `none` empty state when the branch has no open/linked PR', async () => {
    const out = await loadPrSidebarData(
      deps({ fetchPRForBranch: vi.fn(async () => ok<PRInfo | null>(null)) }),
      { worktreeId: 'w', branch: 'feat' }
    )
    expect(out).toEqual({ kind: 'none' })
  })

  it('routes a checks failure through the classifier', async () => {
    const out = await loadPrSidebarData(
      deps({ fetchPRChecks: vi.fn(async () => fail<PRCheckDetail[]>('403 forbidden')) }),
      { worktreeId: 'w', branch: 'feat' }
    )
    expect(out.kind).toBe('blocked')
  })

  it('returns an error state when a dep rejects (no escaping rejection)', async () => {
    const d = deps({
      fetchPRForBranch: vi.fn(async () => {
        throw new Error('transport closed')
      })
    })
    const out = await loadPrSidebarData(d, { worktreeId: 'w', branch: 'feat' })
    expect(out).toEqual({ kind: 'error', message: 'transport closed' })
  })
})

describe('loadPrSidebarDetails (phase 2)', () => {
  function deps(over: Partial<PrSidebarLoadDeps> = {}): PrSidebarLoadDeps {
    return {
      fetchForBranch: vi.fn(async () => ok<HostedReviewInfo | null>(ghInfo())),
      fetchWorktreeLinkedPR: vi.fn(async () => null),
      fetchPRForBranch: vi.fn(async () => ok<PRInfo | null>(PR)),
      fetchWorkItemDetails: vi.fn(async () => ok<GitHubWorkItemDetails | null>(DETAILS)),
      fetchPRChecks: vi.fn(async () => ok<PRCheckDetail[]>(CHECKS)),
      ...over
    }
  }

  it('returns the fetched details', async () => {
    expect(await loadPrSidebarDetails(deps(), 'w', 7)).toBe(DETAILS)
  })

  it('is non-fatal — a details failure yields null rather than erroring the sidebar', async () => {
    const d = deps({
      fetchWorkItemDetails: vi.fn(async () => fail<GitHubWorkItemDetails | null>('network down'))
    })
    expect(await loadPrSidebarDetails(d, 'w', 7)).toBeNull()
  })

  it('is non-fatal when fetchWorkItemDetails rejects (no escaping rejection)', async () => {
    const d = deps({
      fetchWorkItemDetails: vi.fn(async () => {
        throw new Error('transport closed')
      })
    })
    expect(await loadPrSidebarDetails(d, 'w', 7)).toBeNull()
  })
})

describe('shouldApplyResult', () => {
  it('applies only the latest load sequence', () => {
    expect(shouldApplyResult(3, 3)).toBe(true)
    expect(shouldApplyResult(2, 3)).toBe(false)
  })
})
