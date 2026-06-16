import { describe, expect, it, vi } from 'vitest'
import type { GitHubWorkItemDetails, PRCheckDetail, PRInfo } from '../../../src/shared/types'
import type { HostedReviewInfo } from '../../../src/shared/hosted-review'
import type { GitHubPrReadOutcome } from './github-pr-rpc'
import {
  classifyPrSidebarFailure,
  loadPrSidebarData,
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
      fetchPRForBranch: vi.fn(async () => ok<PRInfo | null>(PR)),
      fetchWorkItemDetails: vi.fn(async () => ok<GitHubWorkItemDetails | null>(DETAILS)),
      fetchPRChecks: vi.fn(async () => ok<PRCheckDetail[]>(CHECKS)),
      ...over
    }
  }

  it('loads pr + details + checks into ready, threading the forBranch hint', async () => {
    const d = deps()
    const out = await loadPrSidebarData(d, {
      worktreeId: 'w',
      branch: 'feat',
      headSha: 'sha-status'
    })
    expect(out).toEqual({ kind: 'ready', data: { pr: PR, details: DETAILS, checks: CHECKS } })
    // forBranch's PR number is threaded into prForBranch as the linked hint
    expect(d.fetchPRForBranch).toHaveBeenCalledWith('w', { branch: 'feat', linkedPRNumber: 7 })
    // headSha forwarded to checks (status SHA wins over pr.headSha)
    expect(d.fetchPRChecks).toHaveBeenCalledWith('w', {
      prNumber: 7,
      headSha: 'sha-status',
      prRepo: null
    })
  })

  it('passes a null hint when forBranch finds no PR, and still consults prForBranch', async () => {
    const d = deps({ fetchForBranch: vi.fn(async () => ok<HostedReviewInfo | null>(null)) })
    await loadPrSidebarData(d, { worktreeId: 'w', branch: 'feat' })
    expect(d.fetchPRForBranch).toHaveBeenCalledWith('w', { branch: 'feat', linkedPRNumber: null })
  })

  it('is non-fatal when forBranch errors — prForBranch still resolves', async () => {
    const d = deps({ fetchForBranch: vi.fn(async () => fail<HostedReviewInfo | null>('timeout')) })
    const out = await loadPrSidebarData(d, { worktreeId: 'w', branch: 'feat' })
    expect(out.kind).toBe('ready')
  })

  it('returns the `none` empty state when the branch has no open PR', async () => {
    const out = await loadPrSidebarData(
      deps({ fetchPRForBranch: vi.fn(async () => ok<PRInfo | null>(null)) }),
      { worktreeId: 'w', branch: 'feat' }
    )
    expect(out).toEqual({ kind: 'none' })
  })

  it('routes a transient details failure to error', async () => {
    const out = await loadPrSidebarData(
      deps({
        fetchWorkItemDetails: vi.fn(async () => fail<GitHubWorkItemDetails | null>('network down'))
      }),
      { worktreeId: 'w', branch: 'feat' }
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
      { worktreeId: 'w', branch: 'feat' }
    )
    expect(out.kind).toBe('blocked')
  })

  it('routes a checks failure through the classifier too', async () => {
    const out = await loadPrSidebarData(
      deps({ fetchPRChecks: vi.fn(async () => fail<PRCheckDetail[]>('403 forbidden')) }),
      { worktreeId: 'w', branch: 'feat' }
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
