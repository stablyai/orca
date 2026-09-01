// Step 1 foundation: the host-private operation store's data-structure
// invariants — canonical digest determinism, idempotency-key stability, the
// per-scope settled-ledger bound, and in-flight snapshot lookups. Reconciliation
// and retry idempotency that consume these land in later steps.
import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import {
  AgentLaunchOperationStore,
  MAX_SETTLED_OPERATIONS_PER_SCOPE,
  MAX_SETTLED_OPERATION_SCOPES,
  agentLaunchIdempotencyKey,
  canonicalPayloadDigest,
  mintAgentLaunchOperationId,
  type PendingAgentLaunchSnapshot,
  type SettledAgentLaunchOperation
} from './agent-launch-operation-store'

const SNAPSHOT: AgentLaunchSnapshot = {
  version: 1,
  requestedAgent: 'claude',
  baseAgent: 'claude',
  displayLabel: 'Claude',
  mode: 'built-in',
  argv: ['claude'],
  agentEnv: {},
  capturedEnvPolicy: 'none',
  target: {
    platform: 'darwin',
    execution: 'native',
    shell: 'posix',
    isRemote: false,
    executionHostId: 'local'
  }
}

function pending(overrides: Partial<PendingAgentLaunchSnapshot> = {}): PendingAgentLaunchSnapshot {
  return {
    operationId: mintAgentLaunchOperationId(),
    idempotencyKey: 'key-a',
    scope: 'wt-1',
    clientMutationId: null,
    payloadDigest: 'digest-a',
    launchToken: 'token-a',
    intent: 'interactive',
    snapshot: SNAPSHOT,
    ...overrides
  }
}

function settled(
  overrides: Partial<SettledAgentLaunchOperation> = {}
): SettledAgentLaunchOperation {
  return {
    operationId: mintAgentLaunchOperationId(),
    idempotencyKey: 'key-a',
    scope: 'wt-1',
    payloadDigest: 'digest-a',
    status: 'launched',
    terminalId: 'term-1',
    failureId: null,
    settledAt: 1,
    ...overrides
  }
}

describe('canonicalPayloadDigest', () => {
  it('is insensitive to property order and absent optional fields', () => {
    const a = canonicalPayloadDigest({ action: { kind: 'retry-same' }, agent: 'claude' })
    const b = canonicalPayloadDigest({ agent: 'claude', action: { kind: 'retry-same' } })
    const c = canonicalPayloadDigest({
      agent: 'claude',
      action: { kind: 'retry-same' },
      extra: undefined
    })
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('changes when a meaningful field changes', () => {
    const base = canonicalPayloadDigest({ action: { kind: 'change-agent', agent: 'claude' } })
    const changed = canonicalPayloadDigest({ action: { kind: 'change-agent', agent: 'codex' } })
    expect(base).not.toBe(changed)
  })
})

describe('agentLaunchIdempotencyKey', () => {
  it('is stable for identical inputs and varies by every component', () => {
    const base = agentLaunchIdempotencyKey({
      principal: { kind: 'local' },
      scope: 'wt-1',
      clientMutationId: 'm-1'
    })
    expect(
      agentLaunchIdempotencyKey({
        principal: { kind: 'local' },
        scope: 'wt-1',
        clientMutationId: 'm-1'
      })
    ).toBe(base)
    expect(
      agentLaunchIdempotencyKey({
        principal: { kind: 'local' },
        scope: 'wt-1',
        clientMutationId: 'm-2'
      })
    ).not.toBe(base)
    expect(
      agentLaunchIdempotencyKey({
        principal: { kind: 'local' },
        scope: 'wt-2',
        clientMutationId: 'm-1'
      })
    ).not.toBe(base)
    expect(
      agentLaunchIdempotencyKey({
        principal: { kind: 'remote', id: 'device-1' },
        scope: 'wt-1',
        clientMutationId: 'm-1'
      })
    ).not.toBe(base)
  })
})

describe('mintAgentLaunchOperationId', () => {
  it('mints distinct ids', () => {
    expect(mintAgentLaunchOperationId()).not.toBe(mintAgentLaunchOperationId())
  })
})

describe('in-flight pending snapshots', () => {
  it('stores, looks up by token and idempotency key, and clears', () => {
    const store = new AgentLaunchOperationStore()
    const entry = pending({ idempotencyKey: 'key-x', launchToken: 'token-x' })
    store.beginPending(entry)
    expect(store.getPending('token-x')).toBe(entry)
    expect(store.findPendingByIdempotencyKey('wt-1', 'key-x')).toBe(entry)
    expect(store.findPendingByIdempotencyKey('wt-2', 'key-x')).toBeNull()
    expect(store.pendingSnapshots()).toHaveLength(1)
    expect(store.clearPending('token-x')).toBe(true)
    expect(store.getPending('token-x')).toBeNull()
    expect(store.pendingSnapshots()).toHaveLength(0)
  })

  it('rehydrates durable in-flight snapshots at startup', () => {
    const store = new AgentLaunchOperationStore()
    const a = pending({ launchToken: 'token-1', idempotencyKey: 'k1' })
    const b = pending({ launchToken: 'token-2', idempotencyKey: 'k2' })
    store.rebuildPendingFrom([a, b])
    expect(store.getPending('token-1')).toBe(a)
    expect(store.getPending('token-2')).toBe(b)
  })

  it('releaseSpawnInFlight drops only the in-flight guard, never the pending', () => {
    const store = new AgentLaunchOperationStore()
    store.beginPending(pending({ launchToken: 'token-x' }))
    expect(store.isSpawnInFlight('token-x')).toBe(true)
    store.releaseSpawnInFlight('token-x')
    expect(store.isSpawnInFlight('token-x')).toBe(false)
    expect(store.getPending('token-x')).not.toBeNull()
  })
})

describe('settled ledger', () => {
  it('retains only the newest entries per scope and isolates scopes', () => {
    const store = new AgentLaunchOperationStore()
    for (let index = 0; index < MAX_SETTLED_OPERATIONS_PER_SCOPE + 4; index += 1) {
      store.recordSettled(
        settled({ operationId: `op-${index}`, idempotencyKey: `k-${index}`, settledAt: index })
      )
    }
    store.recordSettled(settled({ scope: 'wt-2', operationId: 'other', idempotencyKey: 'k-other' }))
    const bucket = store.settledForScope('wt-1')
    expect(bucket).toHaveLength(MAX_SETTLED_OPERATIONS_PER_SCOPE)
    // Oldest four evicted; newest retained.
    expect(bucket.at(0)?.operationId).toBe('op-4')
    expect(bucket.at(-1)?.operationId).toBe(`op-${MAX_SETTLED_OPERATIONS_PER_SCOPE + 3}`)
    expect(store.settledForScope('wt-2')).toHaveLength(1)
  })

  it('replaces an existing entry for the same operation rather than growing', () => {
    const store = new AgentLaunchOperationStore()
    store.recordSettled(
      settled({ operationId: 'op-1', status: 'failed', failureId: 'f-1', terminalId: null })
    )
    store.recordSettled(
      settled({ operationId: 'op-1', status: 'launched', terminalId: 't-1', failureId: null })
    )
    const bucket = store.settledForScope('wt-1')
    expect(bucket).toHaveLength(1)
    expect(bucket[0].status).toBe('launched')
    expect(bucket[0].terminalId).toBe('t-1')
  })

  it('finds the newest settled entry by idempotency key', () => {
    const store = new AgentLaunchOperationStore()
    store.recordSettled(
      settled({ operationId: 'op-1', idempotencyKey: 'k-1', status: 'failed', settledAt: 1 })
    )
    store.recordSettled(
      settled({ operationId: 'op-2', idempotencyKey: 'k-1', status: 'launched', settledAt: 2 })
    )
    const found = store.findSettledByIdempotencyKey('wt-1', 'k-1')
    expect(found?.operationId).toBe('op-2')
    expect(store.findSettledByIdempotencyKey('wt-1', 'missing')).toBeNull()
    expect(store.findSettledByIdempotencyKey('wt-9', 'k-1')).toBeNull()
  })

  it('settleAndClearPending lands the settled entry and the pending drop in ONE durable write', () => {
    const store = new AgentLaunchOperationStore()
    const entry = pending()
    store.beginPending(entry)
    const sink = vi.fn()
    store.setDurablePersistence(sink)

    const outcome = settled({
      operationId: entry.operationId,
      idempotencyKey: entry.idempotencyKey,
      scope: entry.scope
    })
    store.settleAndClearPending(outcome, entry.launchToken)

    expect(sink).toHaveBeenCalledTimes(1)
    const written = sink.mock.calls[0][0]
    expect(written.pending).toEqual([])
    expect(written.settled).toEqual([outcome])
    expect(store.getPending(entry.launchToken)).toBeNull()
    expect(store.isSpawnInFlight(entry.launchToken)).toBe(false)
    expect(store.findSettledByIdempotencyKey(entry.scope, entry.idempotencyKey)).toEqual(outcome)
  })

  it('rebuild never invokes the durable sink (locked-keychain recovery re-entry)', () => {
    // The recovery path rebuilds while its sink is still installed as
    // onDurableMutation; a persisting rebuild would re-enter that sink per
    // settled row and recurse.
    const store = new AgentLaunchOperationStore()
    const sink = vi.fn()
    store.setDurablePersistence(sink)
    store.rebuildSettledFrom([settled({ operationId: 'op-1' })])
    store.rebuildPendingFrom([pending()])
    expect(sink).not.toHaveBeenCalled()
    expect(store.settledForScope('wt-1')).toHaveLength(1)
    expect(store.getPending('token-a')).not.toBeNull()
  })

  it('rehydrates the settled ledger in chronological order under the bound', () => {
    const store = new AgentLaunchOperationStore()
    const entries: SettledAgentLaunchOperation[] = []
    for (let index = 0; index < MAX_SETTLED_OPERATIONS_PER_SCOPE + 3; index += 1) {
      entries.push(
        settled({ operationId: `op-${index}`, idempotencyKey: `k-${index}`, settledAt: index })
      )
    }
    // Shuffle the durable order to prove rebuild sorts by settledAt before bounding.
    store.rebuildSettledFrom(entries.toReversed())
    const bucket = store.settledForScope('wt-1')
    expect(bucket).toHaveLength(MAX_SETTLED_OPERATIONS_PER_SCOPE)
    expect(bucket.at(0)?.operationId).toBe('op-3')
    expect(bucket.at(-1)?.operationId).toBe(`op-${MAX_SETTLED_OPERATIONS_PER_SCOPE + 2}`)
  })
})

describe('settled scope bound', () => {
  it('evicts the least-recently-settled scopes past the global bound', () => {
    const store = new AgentLaunchOperationStore()
    const overflow = 5
    for (let index = 0; index < MAX_SETTLED_OPERATION_SCOPES + overflow; index += 1) {
      store.recordSettled(
        settled({ scope: `wt-${index}`, operationId: `op-${index}`, idempotencyKey: `k-${index}` })
      )
    }
    for (let index = 0; index < overflow; index += 1) {
      expect(store.settledForScope(`wt-${index}`)).toHaveLength(0)
    }
    expect(store.settledForScope(`wt-${overflow}`)).toHaveLength(1)
    expect(store.settledForScope(`wt-${MAX_SETTLED_OPERATION_SCOPES + overflow - 1}`)).toHaveLength(
      1
    )
    expect(store.durableState().settled).toHaveLength(MAX_SETTLED_OPERATION_SCOPES)
  })

  it('re-settling an old scope keeps it alive as newest', () => {
    const store = new AgentLaunchOperationStore()
    store.recordSettled(
      settled({ scope: 'wt-old', operationId: 'op-old', idempotencyKey: 'k-old' })
    )
    for (let index = 0; index < MAX_SETTLED_OPERATION_SCOPES; index += 1) {
      store.recordSettled(
        settled({ scope: `wt-${index}`, operationId: `op-${index}`, idempotencyKey: `k-${index}` })
      )
      // Touching wt-old on every append keeps it out of the eviction window.
      store.recordSettled(
        settled({ scope: 'wt-old', operationId: `op-old-${index}`, idempotencyKey: `k-o-${index}` })
      )
    }
    expect(store.settledForScope('wt-old').length).toBeGreaterThan(0)
  })

  it('never evicts a scope an in-flight launch still needs', () => {
    const store = new AgentLaunchOperationStore()
    // The pending launch lands FIRST, so its scope is the oldest by insertion —
    // exactly the entry a naive oldest-first eviction would drop.
    store.recordSettled(
      settled({ scope: 'wt-live', operationId: 'op-live', idempotencyKey: 'k-live' })
    )
    store.beginPending(pending({ scope: 'wt-live', launchToken: 'token-live' }))
    for (let index = 0; index < MAX_SETTLED_OPERATION_SCOPES + 10; index += 1) {
      store.recordSettled(
        settled({ scope: `wt-${index}`, operationId: `op-${index}`, idempotencyKey: `k-${index}` })
      )
    }
    expect(store.settledForScope('wt-live')).toHaveLength(1)
    expect(store.findSettledByIdempotencyKey('wt-live', 'k-live')?.operationId).toBe('op-live')
  })
})
