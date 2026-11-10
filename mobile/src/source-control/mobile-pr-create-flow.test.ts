import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/rpc/rpc-wire-types'
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
})
