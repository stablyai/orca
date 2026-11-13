import { describe, expect, it, vi } from 'vitest'
import { gitStatusHostPayloadSchema } from './git-status-reply-schema'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/rpc/rpc-wire-types'
import { runMobileHostedReviewCreateIntent } from './mobile-hosted-review-create-intent-runner'

function ok(result: unknown): RpcSuccess {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }
}

function fail(message: string): RpcFailure {
  return { id: 'r', ok: false, error: { code: 'x', message }, _meta: { runtimeId: 'rt' } }
}

function status(entries: unknown[], upstreamStatus = { hasUpstream: true, ahead: 0, behind: 0 }) {
  return gitStatusHostPayloadSchema.parse({
    entries,
    conflictOperation: 'unknown',
    branch: 'feature/x',
    head: 'sha',
    upstreamStatus
  })
}

function entry(area: 'unstaged' | 'staged') {
  return { path: 'a.ts', status: 'modified', area }
}

function eligibility(overrides: Record<string, unknown>) {
  return {
    provider: 'github',
    review: null,
    defaultBaseRef: 'main',
    title: 'Ship mobile PR create',
    body: 'Generated body',
    reviewLookupOutcome: 'not_found',
    ...overrides
  }
}

function clientWith(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: Array<{ method: string; params: unknown }>
} {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return responses.shift() ?? fail(`unexpected ${method}`)
    })
  }
}

describe('runMobileHostedReviewCreateIntent', () => {
  it('reports committed work when creation fails after the automatic commit', async () => {
    const client = clientWith([
      ok(status([entry('staged')])),
      ok({ success: true }),
      ok(status([])),
      ok(eligibility({ canCreate: true, blockedReason: null, nextAction: null })),
      ok({ ok: false, code: 'validation', error: 'Create PR failed: bad base' })
    ])

    await expect(
      runMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
        branch: 'feature/x',
        title: 'feature/x',
        status: null,
        commitMessage: 'Use my message'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Create PR failed: bad base',
      committed: true,
      status: expect.objectContaining({ entries: [] })
    })
  })
})
