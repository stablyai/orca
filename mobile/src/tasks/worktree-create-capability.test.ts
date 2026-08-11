import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { readNewWorktreeRuntimeCapabilities } from './worktree-create-capability'

function statusClient(outcomes: Array<'cutover' | 'error' | string[]>): RpcClient {
  let call = 0
  return {
    sendRequest: async () => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
      call += 1
      if (outcome === 'cutover') {
        throw new LogicalClientCutoverError()
      }
      if (outcome === 'error') {
        throw new Error('offline')
      }
      return {
        id: '1',
        ok: true,
        result: { capabilities: outcome },
        _meta: { runtimeId: 'r' }
      }
    }
  } as unknown as RpcClient
}

describe('readNewWorktreeRuntimeCapabilities', () => {
  it('reads task and idempotent-create support from status.get', async () => {
    await expect(
      readNewWorktreeRuntimeCapabilities(
        statusClient([['mobile.tasks.v1', 'worktree.create-idempotency.v1']])
      )
    ).resolves.toEqual({
      tasksSupported: true,
      idempotentWorktreeCreateSupported: true
    })
  })

  it('retries the safe status probe after a connection cutover', async () => {
    await expect(
      readNewWorktreeRuntimeCapabilities(
        statusClient(['cutover', ['worktree.create-idempotency.v1']])
      )
    ).resolves.toEqual({
      tasksSupported: false,
      idempotentWorktreeCreateSupported: true
    })
  })

  it('fails closed when capability detection is unavailable', async () => {
    await expect(readNewWorktreeRuntimeCapabilities(statusClient(['error']))).resolves.toEqual({
      tasksSupported: false,
      idempotentWorktreeCreateSupported: false
    })
  })
})
