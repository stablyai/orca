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
