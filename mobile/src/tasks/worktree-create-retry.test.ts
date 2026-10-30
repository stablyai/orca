import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { isRpcDeliveryUnknown, markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { ConnectionState } from '../transport/types'
import {
  getWorktreeCreateReplayWindowMs,
  WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS,
  type WorktreeCreateIdempotencySupport
} from './worktree-create-idempotency-policy'
import { createWorktreeWithNameRetry } from './worktree-create-retry'
import { WORKTREE_CREATE_TIMEOUT_MS } from './workspace-create-timeout'

type Attempt = { method: string; params: Record<string, unknown> }

const IDEMPOTENT_CREATE_SUPPORT = {
  dedupeTtlMs: WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS
}
const LEGACY_HOST_REPLAY_WINDOW_MS = 50_000

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

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
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
  it('returns the host create warning alongside the worktree', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ id: 'wt-warned', warning: 'Failed to create the startup terminal for /w: no pty' }],
      attempts
    )
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'puffin',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: Promise.resolve(IDEMPOTENT_CREATE_SUPPORT)
      })
    ).resolves.toEqual({
      worktreeId: 'wt-warned',
      name: 'puffin',
      warning: 'Failed to create the startup terminal for /w: no pty'
    })
  })

  it('omits a blank create warning', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ id: 'wt-clean', warning: '  ' }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'puffin',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: Promise.resolve(IDEMPOTENT_CREATE_SUPPORT)
      })
    ).resolves.toEqual({ worktreeId: 'wt-clean', name: 'puffin' })
  })

  it('waits for capability detection before sending a create', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ id: 'wt-ready' }], attempts)
    let resolveSupport!: (supported: WorktreeCreateIdempotencySupport) => void
    const support = new Promise<WorktreeCreateIdempotencySupport>((resolve) => {
      resolveSupport = resolve
    })
    const pending = createWorktreeWithNameRetry({
      client,
      baseName: 'puffin',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: support,
      mintMutationId: () => 'key-ready'
    })

    await Promise.resolve()
    expect(attempts).toHaveLength(0)
    resolveSupport(IDEMPOTENT_CREATE_SUPPORT)

    await expect(pending).resolves.toEqual({ worktreeId: 'wt-ready', name: 'puffin' })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBe('key-ready')
  })

  it('stamps a clientMutationId on the create request', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ id: 'wt-1' }], attempts)
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'otter',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      mintMutationId: () => 'key-1'
    })
    expect(result).toEqual({ worktreeId: 'wt-1', name: 'otter' })
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params).toMatchObject({ name: 'otter', clientMutationId: 'key-1' })
  })

  it('retries a connection-migration cutover with the SAME key, then succeeds', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: new LogicalClientCutoverError() }, { id: 'wt-2' }],
      attempts
    )
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'seal',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      mintMutationId: () => 'key-mig'
    })
    expect(result).toEqual({ worktreeId: 'wt-2', name: 'seal' })
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.params.clientMutationId).toBe('key-mig')
    expect(attempts[1]!.params.clientMutationId).toBe('key-mig')
    expect(attempts[1]!.params.name).toBe('seal')
  })

  it('gives up after the cutover retry budget and rethrows', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new LogicalClientCutoverError() }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'crab',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-x'
      })
    ).rejects.toBeInstanceOf(LogicalClientCutoverError)
    expect(attempts).toHaveLength(6)
  })

  // Unmarked errors are definite failures and must never enter ambiguous replay.
  it('does not treat an ordinary transport error as a cutover', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new Error('Request timed out') }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'eel',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-t'
      })
    ).rejects.toThrow('Request timed out')
    expect(attempts).toHaveLength(1)
  })

  it('mints a fresh key per candidate when a name collision bumps the suffix', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ errorMessage: 'already exists locally' }, { id: 'wt-3' }],
      attempts
    )
    let n = 0
    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'topic',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      mintMutationId: () => `key-${(n += 1)}`
    })
    expect(result).toEqual({ worktreeId: 'wt-3', name: 'topic-2' })
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.params.clientMutationId).toBe('key-1')
    expect(attempts[1]!.params.clientMutationId).toBe('key-2')
    expect(attempts[1]!.params.name).toBe('topic-2')
  })

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

  it('advances generated retries without nesting suffixes', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ errorMessage: 'already exists locally' }, { id: 'wt-generated' }],
      attempts
    )

    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'nautilus-2',
      nameWasGenerated: true,
      buildParams: (name) => ({ repo: 'id:r', name, nameWasGenerated: true }),
      worktreeCreateIdempotency: false
    })

    expect(result).toEqual({ worktreeId: 'wt-generated', name: 'nautilus-3' })
    expect(attempts.map((attempt) => attempt.params.name)).toEqual(['nautilus-2', 'nautilus-3'])
  })

  it('does not replay an ambiguous cutover when the host lacks idempotency support', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new LogicalClientCutoverError() }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'ray',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: false,
        mintMutationId: () => 'must-not-be-used'
      })
    ).rejects.toBeInstanceOf(LogicalClientCutoverError)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBeUndefined()
  })

  it('replays a delivery-ambiguous socket drop with the SAME key once the transport returns', async () => {
    const attempts: Attempt[] = []
    const connection = connectionController()
    const client = scriptedClient(
      [
        {
          throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
          dropsConnection: true
        },
        { id: 'wt-drop' }
      ],
      attempts,
      connection
    )

    const pending = createWorktreeWithNameRetry({
      client,
      baseName: 'urchin',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
      mintMutationId: () => 'key-drop'
    })

    await flush()
    expect(attempts).toHaveLength(1)

    connection.set('connected')
    await expect(pending).resolves.toEqual({ worktreeId: 'wt-drop', name: 'urchin' })
    expect(attempts).toHaveLength(2)
    expect(attempts[1]!.params.clientMutationId).toBe('key-drop')
    expect(attempts[1]!.params.name).toBe('urchin')
  })

  it('does not replay a delivery-ambiguous drop when the host lacks idempotency support', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ throws: markRpcDeliveryUnknown(new Error('Connection interrupted')) }],
      attempts
    )
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'limpet',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: false,
        mintMutationId: () => 'must-not-be-used'
      })
    ).rejects.toThrow('Connection interrupted')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBeUndefined()
  })

  it('disables ambiguous replay for a malformed advertisement', async () => {
    const attempts: Attempt[] = []
    const connection = connectionController()
    const client = scriptedClient(
      [
        {
          throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
          dropsConnection: true
        }
      ],
      attempts,
      connection
    )
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'limpet',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: { dedupeTtlMs: 0 },
        mintMutationId: () => 'key-malformed'
      })
    ).rejects.toThrow('Connection interrupted')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBe('key-malformed')
  })

  it('gives up after the delivery-ambiguity replay budget, still inside the dedupe TTL', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const client = scriptedClient(
        [
          {
            throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
            dropsConnection: true,
            reconnectsAfterMs: 1_000
          }
        ],
        attempts,
        connection
      )
      const startedAt = Date.now()
      let settledAt = -1
      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'barnacle',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-budget'
      }).catch((error: unknown) => {
        settledAt = Date.now()
        throw error
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_DEDUPE_TTL_LEGACY_HOST_MS)
      await settled
      expect(attempts).toHaveLength(3)
      // Every replay must land inside the host’s retention window, after subtracting detection latency.
      expect(settledAt - startedAt).toBeLessThanOrEqual(LEGACY_HOST_REPLAY_WINDOW_MS)
    } finally {
      vi.useRealTimers()
    }
    // Fake-timer advances yield real macrotasks; loaded runners can exceed Vitest’s 5s wall-clock budget.
  }, 30_000)

  it('surfaces the original ambiguity when the transport never comes back', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const client = scriptedClient(
        [
          {
            throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
            dropsConnection: true
          }
        ],
        attempts,
        connection
      )

      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'anemone',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-stuck'
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      await vi.advanceTimersByTimeAsync(60_000)
      await settled
      expect(attempts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    // Fake-timer advances yield real macrotasks; loaded runners can exceed Vitest’s 5s wall-clock budget.
  }, 30_000)

  it('stops replaying when the host-advertised dedupe record has expired', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const client = scriptedClient(
        [
          {
            throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
            dropsConnection: true,
            takesMs: 12_000,
            reconnectsAfterMs: 1_000
          },
          { id: 'wt-duplicate' }
        ],
        attempts,
        connection
      )

      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'mussel',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: { dedupeTtlMs: 20_000 },
        mintMutationId: () => 'key-short-ttl'
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      await vi.advanceTimersByTimeAsync(30_000)
      await settled
      expect(attempts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not replay an ambiguity that surfaced while the transport stayed connected', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const client = scriptedClient(
        [
          {
            // A dropped response on a live socket can outlast host dedupe before request timeout reveals ambiguity.
            throws: markRpcDeliveryUnknown(new Error('Request timed out: worktree.create')),
            takesMs: WORKTREE_CREATE_TIMEOUT_MS
          },
          { id: 'wt-duplicate' }
        ],
        attempts,
        connection,
        // Fresh watchdog replies must not make an unbounded original ambiguity safe to replay.
        () => Date.now()
      )

      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'cuttlefish',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-expired'
      })
      const settled = expect(pending).rejects.toThrow('Request timed out')
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_TIMEOUT_MS)
      await settled
      // Still-connected ambiguity has no bounded detection time; replay could create a duplicate, including same-name folder workspaces.
      expect(connection.getState()).toBe('connected')
      expect(attempts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    // Fake-timer advances yield real macrotasks; loaded runners can exceed Vitest’s 5s wall-clock budget.
  }, 30_000)

  it('clamps a later reconnect wait to what is left of the replay window', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const client = scriptedClient(
        [
          {
            // A second reconnect gets only the remaining window, never a fresh full wait.
            throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
            dropsConnection: true,
            takesMs: 30_000,
            reconnectsAfterMs: 1_000
          },
          {
            throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
            dropsConnection: true
          }
        ],
        attempts,
        connection
      )

      const startedAt = Date.now()
      let settledAt = -1
      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'nautilus',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-clamped'
      }).catch((error: unknown) => {
        settledAt = Date.now()
        throw error
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      await vi.advanceTimersByTimeAsync(LEGACY_HOST_REPLAY_WINDOW_MS)
      await settled
      expect(attempts).toHaveLength(2)
      // Anchor at first ambiguity so repeated drops cannot extend replay beyond host retention.
      expect(settledAt - startedAt).toBe(LEGACY_HOST_REPLAY_WINDOW_MS)
    } finally {
      vi.useRealTimers()
    }
    // Fake-timer advances yield real macrotasks; loaded runners can exceed Vitest’s 5s wall-clock budget.
  }, 30_000)

  it('refuses a replay when the ambiguity surfaced long after the last inbound frame', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const startedAt = Date.now()
      const client = scriptedClient(
        [
          {
            throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
            dropsConnection: true,
            reconnectsAfterMs: 1_000,
            // Simulate JS suspension and socket death discovered only after the phone resumes ten minutes later.
            takesMs: 600_000
          }
        ],
        attempts,
        connection,
        startedAt + 2_000
      )
      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'limpet',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-stale'
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      await vi.advanceTimersByTimeAsync(700_000)
      await settled
      // Expired host retention makes this a new create, so refuse replay.
      expect(attempts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    // Fake-timer advances yield real macrotasks; loaded runners can exceed Vitest’s 5s wall-clock budget.
  }, 30_000)

  it('still replays a long-running create whose socket stayed live until it dropped', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const startedAt = Date.now()
      const client = scriptedClient(
        [
          {
            // A long create can keep the socket fresh before a short detected drop.
            throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
            dropsConnection: true,
            reconnectsAfterMs: 1_000,
            takesMs: 184_000
          },
          { id: 'wt-long' }
        ],
        attempts,
        connection,
        startedAt + 180_000
      )
      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'kelp',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-long'
      })
      await vi.advanceTimersByTimeAsync(250_000)
      // Retention starts at host resolution; a current inbound stamp can prove safety even after a create longer than TTL.
      expect(await pending).toEqual({ worktreeId: 'wt-long', name: 'kelp' })
      expect(attempts).toHaveLength(2)
      expect(attempts[0]!.params.clientMutationId).toBe('key-long')
      expect(attempts[1]!.params.clientMutationId).toBe('key-long')
    } finally {
      vi.useRealTimers()
    }
    // Fake-timer advances yield real macrotasks; loaded runners can exceed Vitest’s 5s wall-clock budget.
  }, 30_000)

  it('does not extend the replay window when the replacement session reports fresher inbound activity', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const startedAt = Date.now()
      // New-session inbound stamps cannot refresh evidence about the original create.
      let lastInboundAt = startedAt + 1_000
      setTimeout(() => {
        lastInboundAt = startedAt + 45_000
      }, 45_000)
      const client = scriptedClient(
        [
          {
            throws: markRpcDeliveryUnknown(new Error('Connection lost')),
            dropsConnection: true,
            takesMs: 40_000,
            reconnectsAfterMs: 1_000
          },
          {
            throws: markRpcDeliveryUnknown(new Error('Connection lost')),
            dropsConnection: true,
            takesMs: 20_000,
            reconnectsAfterMs: 1_000
          },
          { id: 'wt-third' }
        ],
        attempts,
        connection,
        () => lastInboundAt
      )

      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'urchin',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-anchored'
      })
      const settled = expect(pending).rejects.toThrow('Connection lost')
      await vi.advanceTimersByTimeAsync(120_000)
      await settled
      // Keep the first deadline; newer session traffic says nothing about original host resolution.
      expect(attempts).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
    // Fake-timer advances yield real macrotasks; loaded runners can exceed Vitest’s 5s wall-clock budget.
  }, 30_000)

  it('does not replay a dropped transport error that was never marked delivery-unknown', async () => {
    const attempts: Attempt[] = []
    const connection = connectionController()
    const client = scriptedClient(
      // Leaving connected without delivery-unknown still means never sent; do not replay it as reconciliation.
      [{ throws: new Error('Socket closed before send'), dropsConnection: true }],
      attempts,
      connection
    )
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'urchin',
        buildParams: (name) => ({ repo: 'id:r', name }),
        worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT,
        mintMutationId: () => 'key-unmarked'
      })
    ).rejects.toThrow('Socket closed before send')
    expect(attempts).toHaveLength(1)
  })

  // Delivery-unknown uses WeakSet object identity; wrapping the rejection would lose evidence that the host may have created.
  it('rethrows the transport rejection object itself, mark and all', async () => {
    const attempts: Attempt[] = []
    const connection = connectionController()
    const marked = markRpcDeliveryUnknown(new Error('Connection lost'))
    const client = scriptedClient([{ throws: marked }], attempts, connection)
    const caught = await createWorktreeWithNameRetry({
      client,
      baseName: 'kestrel',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: false
    }).then(
      () => null,
      (error: unknown) => error
    )
    expect(caught).toBe(marked)
    expect(isRpcDeliveryUnknown(caught)).toBe(true)
  })

  // Definite failures must not acquire delivery-unknown marks.
  it('does not mark a rejection the transport left unmarked', async () => {
    const attempts: Attempt[] = []
    const unmarked = new Error('Socket closed before send')
    const client = scriptedClient([{ throws: unmarked }], attempts, connectionController())
    const caught = await createWorktreeWithNameRetry({
      client,
      baseName: 'kestrel',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: IDEMPOTENT_CREATE_SUPPORT
    }).then(
      () => null,
      (error: unknown) => error
    )
    expect(caught).toBe(unmarked)
    expect(isRpcDeliveryUnknown(caught)).toBe(false)
  })

  it('keeps the replay window strictly inside the host dedupe TTL', () => {
    // Reserve transit time inside the dedupe TTL so the last replay cannot arrive after expiry.
    expect(getWorktreeCreateReplayWindowMs({ dedupeTtlMs: 60_000 })).toBe(50_000)
    const shortReplayWindowMs = getWorktreeCreateReplayWindowMs({ dedupeTtlMs: 20_000 })
    expect(shortReplayWindowMs).toBe(10_000)
  })
})
