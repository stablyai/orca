import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import { requestMobileCommitMessage } from './mobile-commit-message-ai'

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

describe('requestMobileCommitMessage', () => {
  it.each([
    { errorCode: 42 },
    { errorParams: { label: 'Codex', exitCode: null } },
    { errorParams: ['Codex'] },
    { errorDetail: { message: 'unknown option' } }
  ])('drops malformed optional failure fields: %j', async (invalid) => {
    const client = clientWith([ok({ success: false, error: 'host error', ...invalid })])
    await expect(requestMobileCommitMessage(client, 'wt-1')).resolves.toEqual({
      success: false,
      error: 'host error'
    })
  })

  it('coerces a malformed failure payload to a non-empty error string', async () => {
    const client = clientWith([ok({ success: false })])
    const result = await requestMobileCommitMessage(client, 'wt-1')
    expect(result.success).toBe(false)
    expect(result).toMatchObject({ success: false, error: 'No commit message generated' })
  })

  it('treats an empty message as failure', async () => {
    const client = clientWith([ok({ success: true, message: '' })])
    const result = await requestMobileCommitMessage(client, 'wt-1')
    expect(result.success).toBe(false)
  })
})
