import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItemDetails, PRCheckDetail, PRInfo } from '../../../src/shared/types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import type { GitHubPrReadOutcome } from './github-pr-rpc'
import {
  classifyPrSidebarFailure,
  loadPrSidebarData,
  resolvePrSidebarEligibility,
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
}
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

describe('resolvePrSidebarEligibility', () => {
  function deps(forBranch: GitHubPrReadOutcome<HostedReviewInfo | null>) {
    return { fetchForBranch: vi.fn(async () => forBranch) }
  }

  it('returns eligible for a github PR', async () => {
    const out = await resolvePrSidebarEligibility(deps(ok(ghInfo())), {
      worktreeId: 'w',
      branch: 'feat'
    })
    expect(out).toEqual({ kind: 'eligible', provider: 'github', prNumber: 7 })
  })

  it('hides for a non-github provider', async () => {
    const out = await resolvePrSidebarEligibility(deps(ok(ghInfo({ provider: 'gitlab' }))), {
      worktreeId: 'w',
      branch: 'feat'
    })
    expect(out).toEqual({ kind: 'hidden' })
  })

  it('hides when no PR is linked', async () => {
    const out = await resolvePrSidebarEligibility(deps(ok(null)), {
      worktreeId: 'w',
      branch: 'feat'
    })
    expect(out).toEqual({ kind: 'hidden' })
  })

  it('routes an auth failure to blocked and a network failure to error', async () => {
    const blocked = await resolvePrSidebarEligibility(deps(fail('not connected')), {
      worktreeId: 'w',
      branch: 'feat'
    })
    expect(blocked.kind).toBe('blocked')
    const errored = await resolvePrSidebarEligibility(deps(fail('timeout')), {
      worktreeId: 'w',
      branch: 'feat'
    })
    expect(errored.kind).toBe('error')
  })
})

describe('loadPrSidebarData', () => {
  function deps(over: Partial<Omit<PrSidebarLoadDeps, 'fetchForBranch'>> = {}) {
    return {
      fetchPRForBranch: vi.fn(async () => ok<PRInfo | null>(PR)),
      fetchWorkItemDetails: vi.fn(async () => ok<GitHubWorkItemDetails | null>(DETAILS)),
      fetchPRChecks: vi.fn(async () => ok<PRCheckDetail[]>(CHECKS)),
      ...over
    }
  }

  it('loads pr + details + checks into ready', async () => {
    const d = deps()
    const out = await loadPrSidebarData(d, {
      worktreeId: 'w',
      branch: 'feat',
      headSha: 'sha-status',
      linkedPRNumber: 7
    })
    expect(out).toEqual({ kind: 'ready', data: { pr: PR, details: DETAILS, checks: CHECKS } })
    // linked PR number threaded into prForBranch as the hint
    expect(d.fetchPRForBranch).toHaveBeenCalledWith('w', { branch: 'feat', linkedPRNumber: 7 })
    // headSha forwarded to checks (status SHA wins over pr.headSha)
    expect(d.fetchPRChecks).toHaveBeenCalledWith('w', {
      prNumber: 7,
      headSha: 'sha-status',
      prRepo: null
    })
  })

  it('falls back to the PR head SHA when no status SHA is supplied', async () => {
    const d = deps()
    await loadPrSidebarData(d, { worktreeId: 'w', branch: 'feat', linkedPRNumber: 7 })
    expect(d.fetchPRChecks).toHaveBeenCalledWith('w', {
      prNumber: 7,
      headSha: 'sha-pr',
      prRepo: null
    })
  })

  it('hides when prForBranch resolves null', async () => {
    const out = await loadPrSidebarData(deps({ fetchPRForBranch: vi.fn(async () => ok(null)) }), {
      worktreeId: 'w',
      branch: 'feat',
      linkedPRNumber: 7
    })
    expect(out).toEqual({ kind: 'hidden' })
  })

  it('routes a transient details failure to error', async () => {
    const out = await loadPrSidebarData(
      deps({
        fetchWorkItemDetails: vi.fn(async () => fail<GitHubWorkItemDetails | null>('network down'))
      }),
      { worktreeId: 'w', branch: 'feat', linkedPRNumber: 7 }
    )
    expect(out.kind).toBe('error')
  })

  it('routes a permission details failure to blocked', async () => {
    const out = await loadPrSidebarData(
      deps({
        fetchWorkItemDetails: vi.fn(async () =>
          fail<GitHubWorkItemDetails | null>('permission denied')
        )
      }),
      { worktreeId: 'w', branch: 'feat', linkedPRNumber: 7 }
    )
    expect(out.kind).toBe('blocked')
  })

  it('routes a checks failure through the classifier too', async () => {
    const out = await loadPrSidebarData(
      deps({ fetchPRChecks: vi.fn(async () => fail<PRCheckDetail[]>('403 forbidden')) }),
      { worktreeId: 'w', branch: 'feat', linkedPRNumber: 7 }
    )
    expect(out.kind).toBe('blocked')
  })
})

describe('shouldApplyResult', () => {
  it('applies only the latest load sequence', () => {
    expect(shouldApplyResult(3, 3)).toBe(true)
    expect(shouldApplyResult(2, 3)).toBe(false)
  })
})
