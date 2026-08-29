import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import { readNewWorktreeRuntimeCapabilities } from './worktree-create-capability'
import {
  WORKTREE_CREATE_DEDUPE_TTL_CLIENT_CEILING_MS,
  WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS
} from './worktree-create-idempotency-policy'

type StatusOutcome =
  | 'cutover'
  | 'error'
  | string[]
  | {
      capabilities?: string[]
      worktreeCreateIdempotency?: unknown
    }

function statusClient(outcomes: StatusOutcome[]): RpcClient {
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
      const result = Array.isArray(outcome)
        ? { capabilities: outcome, hostPlatform: 'darwin' }
        : { ...outcome, hostPlatform: 'darwin' }
      return {
        id: '1',
        ok: true,
        result,
        _meta: { runtimeId: 'r' }
      }
    }
  } as unknown as RpcClient
}

describe('readNewWorktreeRuntimeCapabilities', () => {
  it('reads task and idempotent-create support from status.get', async () => {
    await expect(
      readNewWorktreeRuntimeCapabilities(
        statusClient([
          {
            capabilities: ['mobile.tasks.v1', 'worktree.create-idempotency.v1'],
            worktreeCreateIdempotency: { dedupeTtlMs: 20_000 }
          }
        ])
      )
    ).resolves.toEqual({
      tasksSupported: true,
      worktreeCreateIdempotency: { dedupeTtlMs: 20_000 },
      hostPlatform: 'darwin'
    })
  })

  it('uses the bounded fallback for an old idempotent host without an advertisement', async () => {
    await expect(
      readNewWorktreeRuntimeCapabilities(statusClient([['worktree.create-idempotency.v1']]))
    ).resolves.toEqual({
      tasksSupported: false,
      worktreeCreateIdempotency: { dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_CLIENT_CEILING_MS },
      hostPlatform: 'darwin'
    })
  })

  it('fails closed when a valid idempotency container omits dedupeTtlMs', async () => {
    await expect(
      readNewWorktreeRuntimeCapabilities(
        statusClient([
          {
            capabilities: ['worktree.create-idempotency.v1'],
            worktreeCreateIdempotency: {}
          }
        ])
      )
    ).resolves.toEqual({
      tasksSupported: false,
      worktreeCreateIdempotency: { dedupeTtlMs: 0 },
      hostPlatform: 'darwin'
    })
  })

  it.each([
    { label: 'null', value: null },
    { label: 'string', value: 'nonsense' },
    { label: 'number', value: 20_000 },
    { label: 'empty array', value: [] }
  ])(
    'fails closed for a malformed idempotency container ($label)',
    async ({ value: worktreeCreateIdempotency }) => {
      await expect(
        readNewWorktreeRuntimeCapabilities(
          statusClient([
            {
              capabilities: ['worktree.create-idempotency.v1'],
              worktreeCreateIdempotency
            }
          ])
        )
      ).resolves.toEqual({
        tasksSupported: false,
        worktreeCreateIdempotency: { dedupeTtlMs: 0 },
        hostPlatform: 'darwin'
      })
    }
  )

  it('clamps an over-large host advertisement to the client fallback ceiling', async () => {
    await expect(
      readNewWorktreeRuntimeCapabilities(
        statusClient([
          {
            capabilities: ['worktree.create-idempotency.v1'],
            worktreeCreateIdempotency: { dedupeTtlMs: 600_000 }
          }
        ])
      )
    ).resolves.toEqual({
      tasksSupported: false,
      worktreeCreateIdempotency: { dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS },
      hostPlatform: 'darwin'
    })
  })

  it.each(['60000', -1, Number.NaN, 60_000.5, {}])(
    'fails closed for malformed host advertisement %j',
    async (advertisedDedupeTtlMs) => {
      await expect(
        readNewWorktreeRuntimeCapabilities(
          statusClient([
            {
              capabilities: ['worktree.create-idempotency.v1'],
              worktreeCreateIdempotency: { dedupeTtlMs: advertisedDedupeTtlMs }
            }
          ])
        )
      ).resolves.toEqual({
        tasksSupported: false,
        worktreeCreateIdempotency: { dedupeTtlMs: 0 },
        hostPlatform: 'darwin'
      })
    }
  )

  it('retries the safe status probe after a connection cutover', async () => {
    await expect(
      readNewWorktreeRuntimeCapabilities(
        statusClient([
          'cutover',
          {
            capabilities: ['worktree.create-idempotency.v1'],
            worktreeCreateIdempotency: { dedupeTtlMs: 30_000 }
          }
        ])
      )
    ).resolves.toEqual({
      tasksSupported: false,
      worktreeCreateIdempotency: { dedupeTtlMs: 30_000 },
      hostPlatform: 'darwin'
    })
  })

  it('fails closed when capability detection is unavailable', async () => {
    await expect(readNewWorktreeRuntimeCapabilities(statusClient(['error']))).resolves.toEqual({
      tasksSupported: false,
      worktreeCreateIdempotency: false,
      hostPlatform: null
    })
  })
})
