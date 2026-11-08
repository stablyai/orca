import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

import type { ConnectionState } from '../transport/connection/connection-state'

import { createWorktreeWithNameRetry } from './worktree-create-retry'

type Attempt = { method: string; params: Record<string, unknown> }

// Model both pending-frame rejection and leaving connected; replay waits on transport recovery.
function connectionController(): {
  getState: () => ConnectionState
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  set: (next: ConnectionState) => void
} {
  let state: ConnectionState = 'connected'
  const listeners = new Set<(next: ConnectionState) => void>()
  return {
    getState: () => state,
    onStateChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      state = next
      for (const listener of listeners) {
        listener(next)
      }
    }
  }
}

function scriptedClient(
  outcomes: Array<
    | { id: string; displayName?: string; warning?: string }
    | { errorMessage: string }
    // takesMs models how long the ambiguity took to SURFACE — a clean close is
    // instant, a half-open socket waits out the liveness watchdog or the timeout.
    // reconnectsAfterMs brings the transport back so the next replay can run.
    | { throws: unknown; dropsConnection?: boolean; takesMs?: number; reconnectsAfterMs?: number }
  >,
  attempts: Attempt[],
  connection?: ReturnType<typeof connectionController>,
  // Use actual inbound timestamps so freshness survives suspension; absent timestamps fall back to send time.
  lastInboundAt?: number | (() => number)
): RpcClient {
  let call = 0
  return {
    getState: () => connection?.getState() ?? 'connected',
    getLastInboundAt: () =>
      (typeof lastInboundAt === 'function' ? lastInboundAt() : lastInboundAt) ?? null,
    onStateChange: (listener: (state: ConnectionState) => void) =>
      connection?.onStateChange(listener) ?? (() => {}),
    sendRequest: async (method: string, params?: unknown) => {
      attempts.push({ method, params: (params ?? {}) as Record<string, unknown> })
      const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
      call += 1
      if ('throws' in outcome) {
        if (outcome.takesMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, outcome.takesMs))
        }
        if (outcome.dropsConnection) {
          connection?.set('reconnecting')
          if (outcome.reconnectsAfterMs !== undefined) {
            setTimeout(() => connection?.set('connected'), outcome.reconnectsAfterMs)
          }
        }
        throw outcome.throws
      }
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
    }
  } as unknown as RpcClient
}

describe('createWorktreeWithNameRetry', () => {
  // Creation can succeed after PTY spawn failure; warning is the only host explanation.

  // Unmarked errors are definite failures and must never enter ambiguous replay.

  it('uses the host-selected display name after a collision retry', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ errorMessage: 'already exists locally' }, { id: 'wt-host-name', displayName: 'topic-3' }],
      attempts
    )

    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'topic',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: false
      })
    ).resolves.toEqual({ worktreeId: 'wt-host-name', name: 'topic-3' })
  })

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

  // Delivery-unknown uses WeakSet object identity; wrapping the rejection would lose evidence that the host may have created.

  // Definite failures must not acquire delivery-unknown marks.
})
