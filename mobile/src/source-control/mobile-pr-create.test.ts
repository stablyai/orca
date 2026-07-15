import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import type { HostedReviewCreationEligibility } from '../../../src/shared/hosted-review'
import { shouldOpenChecksPanelCreateComposer } from '../../../src/renderer/src/components/right-sidebar/checks-panel-review-creation'
import {
  buildMobilePrCreateParams,
  getMobilePrCreateBlockMessage,
  mobileRepoSelectorFromWorktreeId,
  resolveMobilePrPrefill,
  shouldPushBeforeMobilePrCreate,
  type MobilePrPrefill
} from './mobile-pr-create'

function ok(result: unknown): RpcSuccess {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }
}
function fail(message: string): RpcFailure {
  return { id: 'r', ok: false, error: { code: 'x', message }, _meta: { runtimeId: 'rt' } }
}
function clientWith(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: Array<{ method: string; params: unknown }>
} {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return responses.shift() ?? fail('unexpected')
    })
  }
}

function eligibility(
  overrides: Partial<HostedReviewCreationEligibility> = {}
): HostedReviewCreationEligibility {
  return {
    provider: 'github',
    review: null,
    canCreate: true,
    blockedReason: null,
    nextAction: null,
    defaultBaseRef: 'main',
    title: 'Add feature',
    body: '',
    ...overrides
  }
}

describe('mobileRepoSelectorFromWorktreeId', () => {
  it('extracts the repo id before the :: separator', () => {
    expect(mobileRepoSelectorFromWorktreeId('repo-1::/tmp/wt')).toBe('id:repo-1')
    expect(mobileRepoSelectorFromWorktreeId('repo-1')).toBe('id:repo-1')
  })
})

describe('buildMobilePrCreateParams', () => {
  it('trims fields and drops empty optionals', () => {
    expect(
      buildMobilePrCreateParams('repo-1::/tmp/wt', {
        provider: 'github',
        base: ' main ',
        title: '  Add feature  ',
        body: '   ',
        draft: false,
        useTemplate: true
      })
    ).toEqual({
      repo: 'id:repo-1',
      worktree: 'id:repo-1::/tmp/wt',
      provider: 'github',
      base: 'main',
      title: 'Add feature',
      draft: false,
      useTemplate: true
    })
  })

  it('keeps a non-empty body and head', () => {
    const params = buildMobilePrCreateParams('repo-1::/tmp/wt', {
      provider: 'gitlab',
      base: 'main',
      head: 'feature/x',
      title: 'T',
      body: 'Body text',
      draft: true
    })
    expect(params).toMatchObject({ head: 'feature/x', body: 'Body text', draft: true })
  })
})

describe('mobile create form gating parity', () => {
  it.each([
    { reason: null, canCreate: true },
    { reason: 'dirty', canCreate: false },
    { reason: 'detached_head', canCreate: false },
    { reason: 'default_branch', canCreate: false },
    { reason: 'no_upstream', canCreate: false },
    { reason: 'needs_push', canCreate: false },
    { reason: 'needs_sync', canCreate: false },
    { reason: 'auth_required', canCreate: false },
    { reason: 'unsupported_provider', canCreate: false },
    { reason: 'existing_review', canCreate: false },
    { reason: 'fork_head_unsupported', canCreate: false }
  ] as const)('matches desktop composer gating for $reason', ({ reason, canCreate }) => {
    const desktopEligibility = eligibility({ canCreate, blockedReason: reason })
    const desktopAllowsComposer = shouldOpenChecksPanelCreateComposer({
      activeReview: null,
      isFolder: false,
      branch: 'feature/x',
      hostedReviewCreation: desktopEligibility
    })
    const mobileAllowsComposer =
      getMobilePrCreateBlockMessage({
        provider: desktopEligibility.provider,
        base: desktopEligibility.defaultBaseRef ?? 'main',
        title: desktopEligibility.title ?? 'feature/x',
        body: desktopEligibility.body ?? '',
        canCreate: desktopEligibility.canCreate,
        blockedReason: desktopEligibility.blockedReason,
        nextAction: desktopEligibility.nextAction
      }) === null

    expect(mobileAllowsComposer).toBe(desktopAllowsComposer)
  })

  it('stays safely blocked for a reason added by a newer desktop contract', () => {
    expect(
      getMobilePrCreateBlockMessage({
        provider: 'github',
        base: 'main',
        title: 'Add feature',
        body: '',
        canCreate: false,
        blockedReason: 'future_desktop_reason' as unknown as MobilePrPrefill['blockedReason']
      })
    ).toBe('This branch is not ready for a pull request yet.')
  })
})

describe('resolveMobilePrPrefill', () => {
  const baseArgs = {
    branch: 'feature/x',
    title: 'feature/x',
    hasUncommittedChanges: false,
    hasUpstream: true,
    ahead: 1,
    behind: 0
  }

  it('derives provider/base/title/body from eligibility (non-GitHub honored)', async () => {
    const client = clientWith([
      ok({
        provider: 'gitlab',
        canCreate: true,
        review: null,
        blockedReason: null,
        nextAction: null,
        defaultBaseRef: 'develop',
        title: 'Add feature',
        body: 'Body'
      })
    ])
    await expect(resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)).resolves.toEqual({
      provider: 'gitlab',
      base: 'develop',
      title: 'Add feature',
      body: 'Body',
      canCreate: true,
      blockedReason: null,
      nextAction: null
    })
  })

  it('marks needs_push eligibility for submit-time push parity', async () => {
    const client = clientWith([
      ok({
        provider: 'github',
        canCreate: false,
        review: null,
        blockedReason: 'needs_push',
        nextAction: 'push',
        defaultBaseRef: 'main',
        title: 'Add feature',
        body: ''
      })
    ])
    const prefill = await resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)
    expect(shouldPushBeforeMobilePrCreate(prefill)).toBe(true)
    expect(getMobilePrCreateBlockMessage(prefill)).toBeNull()
  })

  it('returns a mobile block message for desktop-blocked create states', async () => {
    const client = clientWith([
      ok({
        provider: 'github',
        canCreate: false,
        review: null,
        blockedReason: 'dirty',
        nextAction: 'commit',
        defaultBaseRef: 'main'
      })
    ])
    const prefill = await resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)
    expect(getMobilePrCreateBlockMessage(prefill)).toBe(
      'Commit changes before creating a pull request.'
    )
  })

  it('returns a blocked fallback when eligibility is unavailable', async () => {
    const client = clientWith([fail('nope')])
    await expect(resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)).resolves.toEqual({
      provider: 'github',
      base: 'main',
      title: 'feature/x',
      body: '',
      canCreate: false,
      blockedReason: null,
      nextAction: null
    })
  })

  it('blocks without calling the RPC when there is no branch', async () => {
    const client = clientWith([])
    const result = await resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', {
      ...baseArgs,
      branch: undefined
    })
    expect(result.provider).toBe('github')
    expect(result.canCreate).toBe(false)
    expect(result.blockedReason).toBe('detached_head')
    expect(client.calls).toEqual([])
  })
})
