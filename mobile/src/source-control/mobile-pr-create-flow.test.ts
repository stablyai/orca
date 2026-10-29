import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import { createMobilePr } from './mobile-pr-create'

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

  it('persists the same trimmed base ref used for creation', async () => {
    const client = clientWith([
      ok({ ok: true, number: 42, url: 'https://github.com/o/r/pull/42' }),
      ok({ worktree: { linkedPR: 42 } })
    ])

    await expect(
      createMobilePr(client, 'repo-1::/tmp/wt', {
        provider: 'github',
        base: ' main ',
        title: 'T',
        body: '',
        draft: false
      })
    ).resolves.toEqual({ ok: true, number: 42, url: 'https://github.com/o/r/pull/42' })
    expect(client.calls[0].params).toMatchObject({ base: 'main' })
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

  it('pushes before create when eligibility requires it', async () => {
    const client = clientWith([
      ok({ success: true }),
      ok({ ok: true, number: 42, url: 'https://github.com/o/r/pull/42' }),
      ok({ worktree: { linkedPR: 42 } })
    ])

    await expect(
      createMobilePr(client, 'repo-1::/tmp/wt', {
        provider: 'github',
        base: 'main',
        title: 'T',
        body: '',
        draft: false,
        pushBeforeCreate: true
      })
    ).resolves.toEqual({ ok: true, number: 42, url: 'https://github.com/o/r/pull/42' })
    expect(client.calls.map((call) => call.method)).toEqual([
      'git.push',
      'hostedReview.create',
      'worktree.set'
    ])
    expect(client.calls[0].params).toEqual({ worktree: 'id:repo-1::/tmp/wt' })
  })

  it('stops before create when the required push fails', async () => {
    const client = clientWith([fail('rejected')])

    await expect(
      createMobilePr(client, 'repo-1::/tmp/wt', {
        provider: 'github',
        base: 'main',
        title: 'T',
        body: '',
        draft: false,
        pushBeforeCreate: true
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Push failed. Resolve the push error, then try again.'
    })
    expect(client.calls.map((call) => call.method)).toEqual(['git.push'])
  })

  it('returns existing reviews as linkable success outcomes', async () => {
    const client = clientWith([
      ok({
        ok: false,
        code: 'already_exists',
        error: 'Already open',
        existingReview: { number: 42, url: 'https://github.com/o/r/pull/42' }
      }),
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
    ).resolves.toEqual({
      ok: true,
      existing: true,
      number: 42,
      url: 'https://github.com/o/r/pull/42'
    })
    expect(client.calls[1]).toEqual({
      method: 'worktree.set',
      params: { worktree: 'id:repo-1::/tmp/wt', baseRef: 'main', linkedPR: 42 }
    })
  })

  it('returns existing review urls even when no number is available', async () => {
    const client = clientWith([
      ok({
        ok: false,
        code: 'already_exists',
        error: 'Already open',
        existingReview: { url: 'https://github.com/o/r/pull/42' }
      })
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
      existing: true,
      url: 'https://github.com/o/r/pull/42'
    })
    expect(client.calls).toHaveLength(1)
  })

  it('formats create failures after a successful required push like desktop', async () => {
    const client = clientWith([
      ok({ success: true }),
      ok({ ok: false, code: 'validation', error: 'Create PR failed: bad base' })
    ])

    await expect(
      createMobilePr(client, 'repo-1::/tmp/wt', {
        provider: 'github',
        base: 'main',
        title: 'T',
        body: '',
        draft: false,
        pushBeforeCreate: true
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Push succeeded, but PR creation failed: bad base'
    })
  })

  it('maps a host failure result to { ok:false }', async () => {
    const client = clientWith([ok({ ok: false, code: 'validation', error: 'Push first' })])
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
