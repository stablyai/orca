import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  buildMobilePrCreateParams,
  getMobilePrCreateBlockMessage,
  mobileRepoSelectorFromWorktreeId,
  createMobilePr,
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

describe('getMobilePrCreateBlockMessage', () => {
  it('fails closed on an unavailable review lookup even when eligibility looks ready', () => {
    expect(
      getMobilePrCreateBlockMessage({
        provider: 'github',
        base: 'main',
        title: 'Add feature',
        body: '',
        canCreate: true,
        blockedReason: null,
        reviewLookupOutcome: 'unavailable'
      })
    ).toBe(
      'Orca could not confirm whether this branch already has a pull request. Try again in a moment.'
    )
  })

  it('fails closed when an older host sends no review-lookup outcome', () => {
    expect(
      getMobilePrCreateBlockMessage({
        provider: 'github',
        base: 'main',
        title: 'Add feature',
        body: '',
        canCreate: true,
        blockedReason: null
      })
    ).toBe(
      'Orca could not confirm whether this branch already has a pull request. Try again in a moment.'
    )
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

  it('sends back a provider token this build does not list, unchanged', async () => {
    // Round-trip new provider tokens; enum fallback would make the host refuse its own provider.
    const client = clientWith([
      ok({
        provider: 'codeberg',
        canCreate: true,
        review: null,
        blockedReason: null,
        nextAction: null,
        defaultBaseRef: 'main',
        title: 'Add feature',
        body: '',
        reviewLookupOutcome: 'not_found'
      }),
      ok({ ok: true, number: 12, url: 'https://codeberg.test/pr/12' }),
      ok({ worktree: { id: 'wt' } })
    ])
    const prefill = await resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)
    expect(prefill.provider).toBe('codeberg')

    await createMobilePr(client, 'repo-1::/tmp/wt', {
      provider: prefill.provider,
      base: prefill.base,
      title: prefill.title,
      body: prefill.body,
      draft: false
    })
    const created = client.calls.find((call) => call.method === 'hostedReview.create')
    expect(created?.params).toMatchObject({ provider: 'codeberg' })
  })

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
        body: 'Body',
        reviewLookupOutcome: 'not_found'
      })
    ])
    await expect(resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)).resolves.toEqual({
      provider: 'gitlab',
      base: 'develop',
      title: 'Add feature',
      body: 'Body',
      canCreate: true,
      blockedReason: null,
      nextAction: null,
      reviewLookupOutcome: 'not_found'
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
        body: '',
        reviewLookupOutcome: 'not_found'
      })
    ])
    const prefill = await resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)
    expect(shouldPushBeforeMobilePrCreate(prefill)).toBe(true)
    expect(getMobilePrCreateBlockMessage(prefill)).toBeNull()
  })

  it('returns a blocked fallback when eligibility is unavailable', async () => {
    const client = clientWith([fail('nope')])
    const prefill = await resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)
    expect(prefill).toEqual({
      provider: 'github',
      base: 'main',
      title: 'feature/x',
      body: '',
      // Missing canCreate means unresolved eligibility, not a determination that the branch is unready.
      blockedReason: null,
      nextAction: null,
      reviewLookupOutcome: 'unavailable'
    })
    expect(getMobilePrCreateBlockMessage(prefill)).not.toBeNull()
  })

  // Use unavailable copy when eligibility cannot resolve; blocked copy requires an explicit canCreate: false.
  const UNCONFIRMED =
    'Orca could not confirm whether this branch already has a pull request. Try again in a moment.'

  it.each([
    { name: 'a malformed reply', responses: [ok({ provider: 7 })] },
    { name: 'a refusal', responses: [fail('nope')] }
  ])('asks the user to retry after $name', async ({ responses }) => {
    const prefill = await resolveMobilePrPrefill(clientWith(responses), 'repo-1::/tmp/wt', baseArgs)
    expect(prefill.canCreate).toBeUndefined()
    expect(getMobilePrCreateBlockMessage(prefill)).toBe(UNCONFIRMED)
  })

  it('asks the user to retry after a transport rejection', async () => {
    const rejecting = {
      sendRequest: vi.fn(async () => {
        throw new Error('offline')
      })
    }
    const prefill = await resolveMobilePrPrefill(rejecting, 'repo-1::/tmp/wt', baseArgs)
    expect(prefill.canCreate).toBeUndefined()
    expect(getMobilePrCreateBlockMessage(prefill)).toBe(UNCONFIRMED)
  })

  it('still blocks when the host determined the branch is not ready', async () => {
    const client = clientWith([
      ok({
        provider: 'github',
        canCreate: false,
        review: null,
        blockedReason: 'dirty',
        nextAction: 'commit',
        defaultBaseRef: 'main',
        reviewLookupOutcome: 'not_found'
      })
    ])
    const prefill = await resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)
    expect(prefill.canCreate).toBe(false)
    expect(getMobilePrCreateBlockMessage(prefill)).toBe(
      'Commit changes before creating a pull request.'
    )
  })

  it('threads reviewLookupOutcome from eligibility into the prefill and blocks needs_push', async () => {
    const client = clientWith([
      ok({
        provider: 'github',
        canCreate: false,
        review: null,
        blockedReason: 'needs_push',
        nextAction: 'push',
        defaultBaseRef: 'main',
        title: 'Add feature',
        body: '',
        reviewLookupOutcome: 'unavailable'
      })
    ])
    const prefill = await resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)
    expect(prefill.reviewLookupOutcome).toBe('unavailable')
    expect(getMobilePrCreateBlockMessage(prefill)).not.toBeNull()
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
