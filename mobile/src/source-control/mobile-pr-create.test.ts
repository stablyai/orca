import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  buildMobilePrCreateParams,
  createMobilePr,
  mobileRepoSelectorFromWorktreeId,
  resolveMobilePrPrefill
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
        base: 'main',
        title: '  Add feature  ',
        body: '   ',
        draft: false
      })
    ).toEqual({
      repo: 'id:repo-1',
      worktree: 'id:repo-1::/tmp/wt',
      provider: 'github',
      base: 'main',
      title: 'Add feature',
      draft: false
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

describe('createMobilePr', () => {
  it('returns the url on success', async () => {
    const client = clientWith([
      ok({ ok: true, number: 42, url: 'https://github.com/o/r/pull/42' }),
      ok({ worktree: { linkedPR: 42 } })
    ])
    await expect(
      createMobilePr(client, 'repo-1::/tmp/wt', {
        provider: 'github',
        base: 'main',
        title: 'T',
        body: '',
        draft: false
      })
    ).resolves.toEqual({ ok: true, number: 42, url: 'https://github.com/o/r/pull/42' })
    expect(client.calls[0].method).toBe('hostedReview.create')
    expect(client.calls[1]).toEqual({
      method: 'worktree.set',
      params: { worktree: 'id:repo-1::/tmp/wt', baseRef: 'main', linkedPR: 42 }
    })
  })

  it('links created merge requests through the provider-specific worktree field', async () => {
    const client = clientWith([
      ok({ ok: true, number: 7, url: 'https://gitlab.com/o/r/-/merge_requests/7' }),
      ok({ worktree: { linkedGitLabMR: 7 } })
    ])
    await expect(
      createMobilePr(client, 'repo-1::/tmp/wt', {
        provider: 'gitlab',
        base: 'main',
        title: 'T',
        body: '',
        draft: false
      })
    ).resolves.toEqual({
      ok: true,
      number: 7,
      url: 'https://gitlab.com/o/r/-/merge_requests/7'
    })
    expect(client.calls[1]).toEqual({
      method: 'worktree.set',
      params: { worktree: 'id:repo-1::/tmp/wt', baseRef: 'main', linkedGitLabMR: 7 }
    })
  })

  it('keeps the created url when the metadata link refresh fails', async () => {
    const client = clientWith([
      ok({ ok: true, number: 42, url: 'https://github.com/o/r/pull/42' }),
      fail('metadata failed')
    ])

    await expect(
      createMobilePr(client, 'repo-1::/tmp/wt', {
        provider: 'github',
        base: 'main',
        title: 'T',
        body: '',
        draft: false
      })
    ).resolves.toEqual({
      ok: true,
      number: 42,
      url: 'https://github.com/o/r/pull/42',
      linkError: 'metadata failed'
    })
  })

  it('maps a host failure result to { ok:false }', async () => {
    const client = clientWith([ok({ ok: false, code: 'needs_push', error: 'Push first' })])
    await expect(
      createMobilePr(client, 'repo-1::/tmp/wt', {
        provider: 'github',
        base: 'main',
        title: 'T',
        body: '',
        draft: false
      })
    ).resolves.toEqual({ ok: false, error: 'Push first' })
  })

  it('maps an RPC transport failure to { ok:false }', async () => {
    const client = clientWith([fail('disconnected')])
    const result = await createMobilePr(client, 'repo-1::/tmp/wt', {
      provider: 'github',
      base: 'main',
      title: 'T',
      body: '',
      draft: false
    })
    expect(result).toEqual({ ok: false, error: 'disconnected' })
  })

  it('normalizes a thrown sendRequest into { ok:false }', async () => {
    const client = {
      sendRequest: vi.fn(async () => {
        throw new Error('socket hung up')
      })
    } as unknown as Pick<RpcClient, 'sendRequest'>
    await expect(
      createMobilePr(client, 'repo-1::/tmp/wt', {
        provider: 'github',
        base: 'main',
        title: 'T',
        body: '',
        draft: false
      })
    ).resolves.toEqual({ ok: false, error: 'socket hung up' })
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
      body: 'Body'
    })
  })

  it('falls back to github/main when eligibility is unavailable', async () => {
    const client = clientWith([fail('nope')])
    await expect(resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', baseArgs)).resolves.toEqual({
      provider: 'github',
      base: 'main',
      title: 'feature/x',
      body: ''
    })
  })

  it('falls back without calling the RPC when there is no branch', async () => {
    const client = clientWith([])
    const result = await resolveMobilePrPrefill(client, 'repo-1::/tmp/wt', {
      ...baseArgs,
      branch: undefined
    })
    expect(result.provider).toBe('github')
    expect(client.calls).toEqual([])
  })
})
