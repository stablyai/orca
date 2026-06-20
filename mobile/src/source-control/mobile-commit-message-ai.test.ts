import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import { cancelMobileCommitMessage, requestMobileCommitMessage } from './mobile-commit-message-ai'

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
  it('returns the generated message on success', async () => {
    const client = clientWith([ok({ success: true, message: 'feat: do the thing' })])
    await expect(requestMobileCommitMessage(client, 'wt-1')).resolves.toEqual({
      success: true,
      message: 'feat: do the thing'
    })
    expect(client.calls[0]).toEqual({
      method: 'git.generateCommitMessage',
      params: { worktree: 'id:wt-1' }
    })
  })

  it('maps a host failure result to { success:false }', async () => {
    const client = clientWith([ok({ success: false, error: 'no model configured' })])
    await expect(requestMobileCommitMessage(client, 'wt-1')).resolves.toEqual({
      success: false,
      error: 'no model configured'
    })
  })

  it('coerces a malformed failure payload to a non-empty error string', async () => {
    const client = clientWith([ok({ success: false })])
    const result = await requestMobileCommitMessage(client, 'wt-1')
    expect(result.success).toBe(false)
    expect(result).toMatchObject({ success: false, error: 'No commit message generated' })
  })

  it('preserves the canceled flag', async () => {
    const client = clientWith([ok({ success: false, error: 'canceled', canceled: true })])
    await expect(requestMobileCommitMessage(client, 'wt-1')).resolves.toEqual({
      success: false,
      error: 'canceled',
      canceled: true
    })
  })

  it('maps an RPC transport failure to { success:false }', async () => {
    const client = clientWith([fail('disconnected')])
    await expect(requestMobileCommitMessage(client, 'wt-1')).resolves.toEqual({
      success: false,
      error: 'disconnected'
    })
  })

  it('treats an empty message as failure', async () => {
    const client = clientWith([ok({ success: true, message: '' })])
    const result = await requestMobileCommitMessage(client, 'wt-1')
    expect(result.success).toBe(false)
  })
})

describe('cancelMobileCommitMessage', () => {
  it('calls the cancel RPC', async () => {
    const client = clientWith([ok({})])
    await cancelMobileCommitMessage(client, 'wt-1')
    expect(client.calls[0]).toEqual({
      method: 'git.cancelGenerateCommitMessage',
      params: { worktree: 'id:wt-1' }
    })
  })
})
