import { describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/connection/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

import { createWorktreeWithNameRetry } from './worktree-create-retry'

type Attempt = { method: string; params: unknown }

function scriptedClient(
  outcomes: ({ id: string; displayName?: string; warning?: string } | { errorMessage: string })[],
  attempts: Attempt[]
): RpcClient {
  let call = 0
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
    attempts.push({ method, params: params ?? {} })
    const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
    call += 1
    if ('errorMessage' in outcome) {
      return {
        id: '1',
        ok: false,
        error: { code: 'x', message: outcome.errorMessage },
        _meta: { runtimeId: 'r' }
      }
    }
    return {
      id: '1',
      ok: true,
      result: {
        worktree: {
          id: outcome.id,
          ...(outcome.displayName !== undefined ? { displayName: outcome.displayName } : {})
        },
        ...(outcome.warning !== undefined ? { warning: outcome.warning } : {})
      },
      _meta: { runtimeId: 'r' }
    }
  })
  return client
}

describe('createWorktreeWithNameRetry', () => {
  it('falls back to the client candidate when an older host omits displayName', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ errorMessage: 'already exists locally' }, { id: 'wt-legacy' }],
      attempts
    )

    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'topic',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: false
      })
    ).resolves.toEqual({ worktreeId: 'wt-legacy', name: 'topic-2' })
  })
})
