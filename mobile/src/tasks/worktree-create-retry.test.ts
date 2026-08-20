import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { LogicalClientCutoverError } from '../transport/stable-logical-rpc-client'
import type { ConnectionState } from '../transport/types'
import { WORKTREE_CREATE_DEDUPE_TTL_MS } from '../../../src/shared/new-workspace/worktree-create-retry-policy'
import {
  createWorktreeWithNameRetry,
  WORKTREE_CREATE_AMBIGUOUS_RECONNECT_WAIT_MS,
  WORKTREE_CREATE_AMBIGUOUS_REPLAY_WINDOW_MS
} from './worktree-create-retry'
import { WORKTREE_CREATE_TIMEOUT_MS } from './workspace-create-timeout'

type Attempt = { method: string; params: Record<string, unknown> }

// Drives the transport state a replay has to wait on. Production couples the two:
// a socket close rejects the pending frame AND drops the client off 'connected'.
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

// Lets a parked replay reach its state wait before the test resumes the transport.
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

// A client whose per-call outcome is scripted: return an id, a server error
// message, or throw (transport-level rejection, e.g. a connection-migration
// cutover). Records every call so tests can assert on the clientMutationId.
function scriptedClient(
  outcomes: Array<
    | { id: string }
    | { errorMessage: string }
    // takesMs models how long the ambiguity took to SURFACE — a clean close is
    // instant, a half-open socket waits out the liveness watchdog or the timeout.
    // reconnectsAfterMs brings the transport back so the next replay can run.
    | { throws: unknown; dropsConnection?: boolean; takesMs?: number; reconnectsAfterMs?: number }
  >,
  attempts: Attempt[],
  connection?: ReturnType<typeof connectionController>,
  // Wall-clock stamp of the last frame that really arrived. Absent = a transport that
  // can't vouch for one, which must fall back to the send; a function models a live
  // socket whose stamp keeps advancing.
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
        result: { worktree: { id: outcome.id } },
        _meta: { runtimeId: 'r' }
      }
    }
  } as unknown as RpcClient
}

describe('createWorktreeWithNameRetry', () => {
  it('waits for capability detection before sending a create', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ id: 'wt-ready' }], attempts)
    let resolveSupport!: (supported: boolean) => void
    const support = new Promise<boolean>((resolve) => {
      resolveSupport = resolve
    })
    const pending = createWorktreeWithNameRetry({
      client,
      baseName: 'puffin',
      buildParams: (name) => ({ repo: 'id:r', name }),
      supportsIdempotentCutoverRetry: support,
      mintMutationId: () => 'key-ready'
    })

    await Promise.resolve()
    expect(attempts).toHaveLength(0)
    resolveSupport(true)

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
      supportsIdempotentCutoverRetry: true,
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
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => 'key-mig'
    })
    expect(result).toEqual({ worktreeId: 'wt-2', name: 'seal' })
    expect(attempts).toHaveLength(2)
    // Idempotency: both the interrupted send and the retry carry one key so the
    // host dedupes instead of creating a duplicate worktree.
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
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-x'
      })
    ).rejects.toBeInstanceOf(LogicalClientCutoverError)
    // Initial attempt + 5 retries.
    expect(attempts).toHaveLength(6)
  })

  // Also the delivery-ambiguity guard: an unmarked error is a DEFINITE failure, so
  // neither the cutover nor the replay path may re-issue it.
  it('does not treat an ordinary transport error as a cutover', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient([{ throws: new Error('Request timed out') }], attempts)
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'eel',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: true,
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
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => `key-${(n += 1)}`
    })
    expect(result).toEqual({ worktreeId: 'wt-3', name: 'topic-2' })
    expect(attempts).toHaveLength(2)
    // A collision is a genuinely different create, so it gets a distinct key.
    expect(attempts[0]!.params.clientMutationId).toBe('key-1')
    expect(attempts[1]!.params.clientMutationId).toBe('key-2')
    expect(attempts[1]!.params.name).toBe('topic-2')
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
      supportsIdempotentCutoverRetry: false
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
        supportsIdempotentCutoverRetry: false,
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
      supportsIdempotentCutoverRetry: true,
      mintMutationId: () => 'key-drop'
    })

    await flush()
    // Parked on the reconnect, not resent onto a dead socket.
    expect(attempts).toHaveLength(1)

    connection.set('connected')
    await expect(pending).resolves.toEqual({ worktreeId: 'wt-drop', name: 'urchin' })
    expect(attempts).toHaveLength(2)
    // Idempotency: the host dedupes the replay against the create it may already
    // have finished, instead of building a second worktree.
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
        supportsIdempotentCutoverRetry: false,
        mintMutationId: () => 'must-not-be-used'
      })
    ).rejects.toThrow('Connection interrupted')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.params.clientMutationId).toBeUndefined()
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
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-budget'
      }).catch((error: unknown) => {
        settledAt = Date.now()
        throw error
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_DEDUPE_TTL_MS)
      await settled
      // Initial attempt + 2 replays.
      expect(attempts).toHaveLength(3)
      // The budget is a count, but what keeps a replay reconciling instead of building
      // a second worktree is wall clock: every attempt has to land while the host still
      // holds the record, with the watchdog's detection latency already deducted.
      expect(settledAt - startedAt).toBeLessThanOrEqual(WORKTREE_CREATE_AMBIGUOUS_REPLAY_WINDOW_MS)
    } finally {
      vi.useRealTimers()
    }
    // Generous: advanceTimersByTimeAsync yields through REAL macrotasks between ticks,
    // so vitest's default 5s real-time budget is reachable on a loaded runner.
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
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-stuck'
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      // A phone that never reconnects must not leave the Create spinner parked.
      await vi.advanceTimersByTimeAsync(60_000)
      await settled
      expect(attempts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    // Generous: advanceTimersByTimeAsync yields through REAL macrotasks between ticks,
    // so vitest's default 5s real-time budget is reachable on a loaded runner.
  }, 30_000)

  it('does not replay an ambiguity that surfaced while the transport stayed connected', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const client = scriptedClient(
        [
          {
            // A silently dropped response frame leaves the socket alive, so nothing
            // rejects until the request timeout — by then the host resolved at an
            // unknowable point and its dedupe record is very likely gone.
            throws: markRpcDeliveryUnknown(new Error('Request timed out: worktree.create')),
            takesMs: WORKTREE_CREATE_TIMEOUT_MS
          },
          { id: 'wt-duplicate' }
        ],
        attempts,
        connection,
        // Watchdog probes keep answering throughout, so the replay window looks wide
        // open on arrival: only the still-connected guard can stop this replay.
        () => Date.now()
      )

      const pending = createWorktreeWithNameRetry({
        client,
        baseName: 'cuttlefish',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-expired'
      })
      const settled = expect(pending).rejects.toThrow('Request timed out')
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_TIMEOUT_MS)
      await settled
      // Never left 'connected', so no drop was ever detected and the staleness of the
      // ambiguity is unbounded. Re-sending would miss the record and build a SECOND
      // worktree — for a folder workspace, one with the very same name.
      expect(connection.getState()).toBe('connected')
      expect(attempts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    // Generous: advanceTimersByTimeAsync yields through REAL macrotasks between ticks,
    // so vitest's default 5s real-time budget is reachable on a loaded runner.
  }, 30_000)

  it('clamps a later reconnect wait to what is left of the replay window', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const client = scriptedClient(
        [
          {
            // Most of the window is already gone by the time the drop is reported, so the
            // remainder — not the full wait — is what the second wait gets.
            throws: markRpcDeliveryUnknown(new Error('Connection interrupted')),
            dropsConnection: true,
            takesMs: 30_000,
            reconnectsAfterMs: 1_000
          },
          {
            // Second drop, and this time the phone never comes back.
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
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-clamped'
      }).catch((error: unknown) => {
        settledAt = Date.now()
        throw error
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      await vi.advanceTimersByTimeAsync(WORKTREE_CREATE_AMBIGUOUS_REPLAY_WINDOW_MS)
      await settled
      expect(attempts).toHaveLength(2)
      // The window is anchored at the FIRST ambiguity, so the second wait gets only the
      // remainder — it must not restart a full wait and carry the replay past the record.
      expect(settledAt - startedAt).toBe(WORKTREE_CREATE_AMBIGUOUS_REPLAY_WINDOW_MS)
    } finally {
      vi.useRealTimers()
    }
    // Generous: advanceTimersByTimeAsync yields through REAL macrotasks between ticks,
    // so vitest's default 5s real-time budget is reachable on a loaded runner.
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
            // The phone was backgrounded: the OS suspended JS and killed the socket, and
            // nothing observed the drop until the app came back ten minutes later.
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
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-stale'
      })
      const settled = expect(pending).rejects.toThrow('Connection interrupted')
      await vi.advanceTimersByTimeAsync(700_000)
      await settled
      // The host forgot this create ~9 minutes ago. A replay would not reconcile — it
      // would build a second worktree — so the create fails instead.
      expect(attempts).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
    // Generous: advanceTimersByTimeAsync yields through REAL macrotasks between ticks,
    // so vitest's default 5s real-time budget is reachable on a loaded runner.
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
            // Three minutes of clone/fetch with the socket answering probes throughout,
            // then it drops and the watchdog reports it four seconds later.
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
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-long'
      })
      await vi.advanceTimersByTimeAsync(250_000)
      // Anchoring at the send would refuse this — the create outran the TTL long before it
      // went ambiguous — but the record only starts ticking when the host RESOLVES, and the
      // live socket proves our knowledge was current.
      expect(await pending).toEqual({ worktreeId: 'wt-long', name: 'kelp' })
      expect(attempts).toHaveLength(2)
      expect(attempts[0]!.params.clientMutationId).toBe('key-long')
      expect(attempts[1]!.params.clientMutationId).toBe('key-long')
    } finally {
      vi.useRealTimers()
    }
    // Generous: advanceTimersByTimeAsync yields through REAL macrotasks between ticks,
    // so vitest's default 5s real-time budget is reachable on a loaded runner.
  }, 30_000)

  it('does not extend the replay window when the replacement session reports fresher inbound activity', async () => {
    vi.useFakeTimers()
    try {
      const attempts: Attempt[] = []
      const connection = connectionController()
      const startedAt = Date.now()
      // The replacement session starts answering probes, so its inbound stamp is far
      // newer than anything that bears on when the ORIGINAL create resolved host-side.
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
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-anchored'
      })
      const settled = expect(pending).rejects.toThrow('Connection lost')
      await vi.advanceTimersByTimeAsync(120_000)
      await settled
      // The deadline is fixed at the FIRST ambiguity. Re-reading it here would buy another
      // 50s of window off a stamp that says nothing about the original request.
      expect(attempts).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
    // Generous: advanceTimersByTimeAsync yields through REAL macrotasks between ticks,
    // so vitest's default 5s real-time budget is reachable on a loaded runner.
  }, 30_000)

  it('does not replay a dropped transport error that was never marked delivery-unknown', async () => {
    const attempts: Attempt[] = []
    const connection = connectionController()
    const client = scriptedClient(
      // Unmarked: the frame is known NOT to have reached the wire, so the host never saw
      // it and a replay would be a second create, not a reconciliation. The transport
      // still leaves 'connected', so only the delivery-unknown check stops this.
      [{ throws: new Error('Socket closed before send'), dropsConnection: true }],
      attempts,
      connection
    )
    await expect(
      createWorktreeWithNameRetry({
        client,
        baseName: 'urchin',
        buildParams: (name) => ({ repo: 'id:r', name }),
        supportsIdempotentCutoverRetry: true,
        mintMutationId: () => 'key-unmarked'
      })
    ).rejects.toThrow('Socket closed before send')
    expect(attempts).toHaveLength(1)
  })

  it('keeps the replay window strictly inside the host dedupe TTL', () => {
    // The window is measured from a lower bound on when the host could have resolved, so
    // it has to leave the record room for the replay to still be in flight. Widening it
    // to the whole TTL would let the last replay land on a record that just expired.
    expect(WORKTREE_CREATE_AMBIGUOUS_REPLAY_WINDOW_MS).toBeGreaterThan(0)
    expect(WORKTREE_CREATE_AMBIGUOUS_REPLAY_WINDOW_MS).toBeLessThan(WORKTREE_CREATE_DEDUPE_TTL_MS)
    // A single wait must not be able to consume the window on its own.
    expect(WORKTREE_CREATE_AMBIGUOUS_RECONNECT_WAIT_MS).toBeLessThan(
      WORKTREE_CREATE_AMBIGUOUS_REPLAY_WINDOW_MS
    )
  })
})
