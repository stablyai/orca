// U5: the host-private session record store's lifecycle invariants — spawn-time
// staging, provider-session bind (by launch token) → durable resume record,
// ownership-key resolution, incompatible/non-resumable bind rejection, spawn-
// failure rollback, dispose-keeps-record, and the one-time legacy handoff.
import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunchSnapshot } from '../../shared/agent-launch-host-contract'
import type { TuiAgent } from '../../shared/types'
import {
  getAgentSessionOwnershipKey,
  type AgentProviderSessionMetadata,
  type AgentSessionOwnershipKey,
  type SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import {
  AgentSessionRecordStore,
  type AgentSessionRecordStoreDurableState,
  type StagedLaunchRegistration
} from './agent-session-record-store'
import { MAX_SESSION_RECORDS } from './agent-session-record-retention'

function snapshot(overrides: Partial<AgentLaunchSnapshot> = {}): AgentLaunchSnapshot {
  return {
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
    },
    ...overrides
  }
}

const SESSION: AgentProviderSessionMetadata = { key: 'session_id', id: 'sess-1' }

function registration(
  overrides: Partial<Omit<StagedLaunchRegistration, 'registeredAt'>> = {}
): Omit<StagedLaunchRegistration, 'registeredAt'> {
  return {
    paneKey: 'pane-a',
    terminalId: 'term-a',
    worktreeId: 'wt-1',
    requestedAgent: 'claude',
    baseAgent: 'claude',
    launchSnapshot: snapshot(),
    launchToken: 'token-a',
    ...overrides
  }
}

const OWNERSHIP: AgentSessionOwnershipKey = {
  worktreeId: 'wt-1',
  baseAgent: 'claude',
  providerSessionId: 'sess-1'
}

/** Register the default pane and bind its provider session by token. */
function registerAndBind(store: AgentSessionRecordStore): void {
  store.register(registration())
  store.bindProviderSessionByToken('token-a', SESSION)
}

describe('AgentSessionRecordStore lifecycle', () => {
  it('a staged registration is not resumable until a provider session binds', () => {
    const store = new AgentSessionRecordStore()
    store.register(registration())
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()

    const bound = store.bindProviderSessionByToken('token-a', SESSION)
    expect(bound).not.toBeNull()
    const record = store.resolveByOwnershipKey(OWNERSHIP)
    expect(record?.launchSnapshot).toEqual(snapshot())
    expect(record?.launchToken).toBe('token-a')
    expect(record?.requestedAgent).toBe('claude')
  })

  it('preserves the requested custom identity while keying ownership on the base', () => {
    const store = new AgentSessionRecordStore()
    store.register(
      registration({ requestedAgent: 'custom-agent:claude:reviewer', baseAgent: 'claude' })
    )
    store.bindProviderSessionByToken('token-a', SESSION)
    const record = store.resolveByOwnershipKey(OWNERSHIP)
    expect(record?.requestedAgent).toBe('custom-agent:claude:reviewer')
    expect(record?.baseAgent).toBe('claude')
  })

  it('binding an unknown launch token returns null and stores nothing', () => {
    const store = new AgentSessionRecordStore()
    expect(store.bindProviderSessionByToken('ghost-token', SESSION)).toBeNull()
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()
  })

  it('rejects an incompatible provider key type without rewriting the staged identity', () => {
    const store = new AgentSessionRecordStore()
    store.register(registration())
    // Claude keys on session_id; a conversation_id hook is incompatible evidence.
    const bound = store.bindProviderSessionByToken('token-a', { key: 'conversation_id', id: 'x' })
    expect(bound).toBeNull()
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()
    // A later compatible hook still binds the same staged registration.
    expect(store.bindProviderSessionByToken('token-a', SESSION)).not.toBeNull()
  })

  it('never binds a non-resumable base', () => {
    const store = new AgentSessionRecordStore()
    store.register(registration({ baseAgent: 'cursor' }))
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
  })

  it('a repeated hook for an already-bound launch is a no-op with no extra persist', () => {
    let persistCalls = 0
    const store = new AgentSessionRecordStore()
    store.setDurablePersistence(() => {
      persistCalls += 1
    })
    store.register(registration())
    expect(store.bindProviderSessionByToken('token-a', SESSION)).not.toBeNull()
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
    expect(persistCalls).toBe(1)
  })

  it('re-binds a ROTATED provider session id under the new ownership key (L2-#4 rebind)', () => {
    // Claude /clear mints a NEW session id in the same pane. The launch token
    // already bound and consumed staging, so the rotated hook must re-key the
    // launch — otherwise resume misses the live session forever.
    const store = new AgentSessionRecordStore()
    registerAndBind(store)

    const rotated = store.bindProviderSessionByToken('token-a', {
      key: 'session_id',
      id: 'sess-2'
    })
    expect(rotated?.providerSession.id).toBe('sess-2')
    const rotatedKey: AgentSessionOwnershipKey = { ...OWNERSHIP, providerSessionId: 'sess-2' }
    expect(store.resolveByOwnershipKey(rotatedKey)?.launchSnapshot).toEqual(snapshot())
    // The prior session's record survives (its transcript is still a valid
    // resume target) but no longer claims the token.
    expect(store.resolveByOwnershipKey(OWNERSHIP)).not.toBeNull()
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.launchToken).toBeUndefined()

    // A rollback after rotation removes only the token's CURRENT record.
    store.rollbackByToken('token-a')
    expect(store.resolveByOwnershipKey(rotatedKey)).toBeNull()
    expect(store.resolveByOwnershipKey(OWNERSHIP)).not.toBeNull()
  })

  it('a rotated hook with an unchanged id or incompatible key stays a null no-op', () => {
    const store = new AgentSessionRecordStore()
    registerAndBind(store)
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
    expect(
      store.bindProviderSessionByToken('token-a', { key: 'conversation_id', id: 'conv-9' })
    ).toBeNull()
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.launchToken).toBe('token-a')
  })

  it('rollback after bind removes the durable record so a failed spawn strands nothing', () => {
    const store = new AgentSessionRecordStore()
    registerAndBind(store)
    store.rollbackByToken('token-a')
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()
  })

  it('rollback before bind drops the staged registration and its token index', () => {
    const store = new AgentSessionRecordStore()
    store.register(registration())
    store.rollbackByToken('token-a')
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
  })

  it('dispose keeps the durable record so a slept session still resumes', () => {
    const store = new AgentSessionRecordStore()
    registerAndBind(store)
    store.disposeStagingForPane('pane-a')
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.launchSnapshot).toEqual(snapshot())
  })

  it('dispose clears an unbound pane staging so a late hook cannot bind a torn-down pane', () => {
    const store = new AgentSessionRecordStore()
    // Registered but never bound (spawn failed / pane closed before the hook).
    store.register(registration())
    store.disposeStagingForPane('pane-a')
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
  })

  it('dispose by terminal clears staging a pane-less surface registered', () => {
    const store = new AgentSessionRecordStore()
    // Runtime/mobile launches carry a terminal id but never a stable pane key,
    // so the pane teardown can never reach them.
    store.register(registration({ paneKey: undefined, terminalId: 'term-a' }))
    store.disposeStagingForPane('pane-a')
    store.disposeStagingForTerminal('term-a')
    expect(store.bindProviderSessionByToken('token-a', SESSION)).toBeNull()
  })

  it('bounds retained durable records, least-recently-updated first', () => {
    let clock = 0
    const store = new AgentSessionRecordStore({ now: () => (clock += 1) })
    const total = MAX_SESSION_RECORDS + 4
    for (let index = 0; index < total; index += 1) {
      store.register(registration({ launchToken: `token-${index}`, paneKey: `pane-${index}` }))
      store.bindProviderSessionByToken(`token-${index}`, { key: 'session_id', id: `sess-${index}` })
    }
    expect(store.durableState().records).toHaveLength(MAX_SESSION_RECORDS)
    for (let index = 0; index < 4; index += 1) {
      expect(
        store.resolveByOwnershipKey({ ...OWNERSHIP, providerSessionId: `sess-${index}` })
      ).toBeNull()
    }
    // The record the last bind just created is never the eviction candidate.
    expect(
      store.resolveByOwnershipKey({ ...OWNERSHIP, providerSessionId: `sess-${total - 1}` })
    ).not.toBeNull()
  })

  it('trims a pre-bound record file at rehydrate without a write', () => {
    let clock = 0
    const seed = new AgentSessionRecordStore({ now: () => (clock += 1) })
    for (let index = 0; index < MAX_SESSION_RECORDS + 3; index += 1) {
      seed.register(registration({ launchToken: `token-${index}` }))
      seed.bindProviderSessionByToken(`token-${index}`, { key: 'session_id', id: `sess-${index}` })
    }
    const store = new AgentSessionRecordStore()
    const sink = vi.fn()
    store.setDurablePersistence(sink)
    store.rebuildRecordsFrom(seed.durableState().records)
    expect(store.durableState().records).toHaveLength(MAX_SESSION_RECORDS)
    expect(sink).not.toHaveBeenCalled()
  })

  it('two custom ids on one base/provider session resolve to one owner record', () => {
    const store = new AgentSessionRecordStore()
    store.register(
      registration({ requestedAgent: 'custom-agent:claude:a', launchToken: 'token-a' })
    )
    store.bindProviderSessionByToken('token-a', SESSION)
    store.register(
      registration({
        paneKey: 'pane-b',
        terminalId: 'term-b',
        requestedAgent: 'custom-agent:claude:b',
        launchToken: 'token-b'
      })
    )
    store.bindProviderSessionByToken('token-b', SESSION)
    // Same ownership key: the later bind overwrites; still one record.
    expect(store.durableState().records).toHaveLength(1)
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.requestedAgent).toBe('custom-agent:claude:b')
  })

  it('a fork binds a NEW provider session into its own record and never mutates the source', () => {
    const store = new AgentSessionRecordStore()
    // Source session, bound to sess-1.
    registerAndBind(store)
    const source = store.resolveByOwnershipKey(OWNERSHIP)
    // Fork: its own launch token + a COPY of the source snapshot, but the forked
    // CLI reports a brand-new provider session id, so it keys a distinct record.
    store.register(
      registration({
        paneKey: 'pane-fork',
        terminalId: 'term-fork',
        requestedAgent: 'custom-agent:claude:fork',
        launchToken: 'token-fork'
      })
    )
    store.bindProviderSessionByToken('token-fork', { key: 'session_id', id: 'sess-2-fork' })
    // Source record is untouched (same identity, same token — no ownership claim).
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toEqual(source)
    // The fork owns a separate record under its new provider session id.
    const forkKey: AgentSessionOwnershipKey = {
      worktreeId: 'wt-1',
      baseAgent: 'claude',
      providerSessionId: 'sess-2-fork'
    }
    expect(store.resolveByOwnershipKey(forkKey)?.requestedAgent).toBe('custom-agent:claude:fork')
    expect(store.durableState().records).toHaveLength(2)
  })

  it('forget removes the durable record', () => {
    const store = new AgentSessionRecordStore()
    registerAndBind(store)
    expect(store.forget(OWNERSHIP)).toBe(true)
    expect(store.resolveByOwnershipKey(OWNERSHIP)).toBeNull()
    expect(store.forget(OWNERSHIP)).toBe(false)
  })
})

describe('AgentSessionRecordStore legacy handoff', () => {
  const legacyConfig: SleepingAgentLaunchConfig = {
    agentArgs: '--resume sess-1',
    agentEnv: { FOO: 'bar' }
  }

  it('ingests the legacy config once and keys it by ownership', () => {
    const store = new AgentSessionRecordStore()
    const record = store.ingestLegacyRecord({
      ownershipKey: OWNERSHIP,
      requestedAgent: 'claude',
      providerSession: SESSION,
      legacyLaunchConfig: legacyConfig,
      connectionId: 'ssh:box'
    })
    expect(record.legacyLaunchConfig).toEqual(legacyConfig)
    expect(record.legacyConnectionId).toBe('ssh:box')
    expect(record.launchSnapshot).toBeUndefined()
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.legacyLaunchConfig).toEqual(legacyConfig)
  })

  it('never overwrites a host-owned record on a repeated handoff', () => {
    const store = new AgentSessionRecordStore()
    registerAndBind(store)
    const returned = store.ingestLegacyRecord({
      ownershipKey: OWNERSHIP,
      requestedAgent: 'claude',
      providerSession: SESSION,
      legacyLaunchConfig: legacyConfig,
      connectionId: null
    })
    // The v1-snapshot record wins; the legacy blob is discarded.
    expect(returned.launchSnapshot).toEqual(snapshot())
    expect(returned.legacyLaunchConfig).toBeUndefined()
  })
})

describe('AgentSessionRecordStore durable persistence', () => {
  it('routes bind/ingest/forget through the sink and rehydrates by ownership key', () => {
    let persisted: AgentSessionRecordStoreDurableState = { records: [] }
    const store = new AgentSessionRecordStore()
    store.setDurablePersistence((state) => {
      persisted = state
    })
    registerAndBind(store)
    expect(persisted.records).toHaveLength(1)

    const rebuilt = new AgentSessionRecordStore()
    rebuilt.rebuildRecordsFrom(persisted.records)
    expect(rebuilt.resolveByOwnershipKey(OWNERSHIP)?.launchToken).toBe('token-a')
  })

  it('register alone does not persist; only a bound record is durable', () => {
    let calls = 0
    const store = new AgentSessionRecordStore()
    store.setDurablePersistence(() => {
      calls += 1
    })
    store.register(registration())
    expect(calls).toBe(0)
    store.bindProviderSessionByToken('token-a', SESSION)
    expect(calls).toBe(1)
  })

  it('rehydrate keys records on the base+session, not the persisted array order', () => {
    const store = new AgentSessionRecordStore()
    const other = getAgentSessionOwnershipKey({
      worktreeId: 'wt-2',
      baseAgent: 'codex',
      providerSessionId: 'sess-2'
    })
    store.rebuildRecordsFrom([
      {
        worktreeId: 'wt-1',
        requestedAgent: 'claude',
        baseAgent: 'claude',
        providerSession: SESSION,
        launchSnapshot: snapshot(),
        registeredAt: 1,
        updatedAt: 1
      },
      {
        worktreeId: 'wt-2',
        requestedAgent: 'codex',
        baseAgent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-2' },
        launchSnapshot: snapshot({ baseAgent: 'codex', requestedAgent: 'codex' }),
        registeredAt: 2,
        updatedAt: 2
      }
    ])
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.baseAgent).toBe('claude')
    expect(
      store.resolveByOwnershipKey({
        worktreeId: 'wt-2',
        baseAgent: 'codex',
        providerSessionId: 'sess-2'
      })?.baseAgent
    ).toBe('codex')
    expect(other).toContain('codex')
  })

  it('rehydrate strips a shape-corrupt snapshot so resume degrades in-band, not a throw', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      {
        worktreeId: 'wt-1',
        requestedAgent: 'claude',
        baseAgent: 'claude',
        providerSession: SESSION,
        // Corrupt persisted snapshot (no argv/agentEnv/target): the replay path
        // reads those fields without re-validating shape.
        launchSnapshot: { version: 1 } as unknown as AgentLaunchSnapshot,
        registeredAt: 1,
        updatedAt: 1
      }
    ])
    const record = store.resolveByOwnershipKey(OWNERSHIP)
    expect(record).not.toBeNull()
    expect(record?.launchSnapshot).toBeUndefined()
  })

  it('rehydrate strips a shape-corrupt legacy config and drops an invalid requested identity', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      {
        worktreeId: 'wt-1',
        requestedAgent: 'claude',
        baseAgent: 'claude',
        providerSession: SESSION,
        legacyLaunchConfig: {
          agentArgs: 42,
          agentEnv: null
        } as unknown as SleepingAgentLaunchConfig,
        registeredAt: 1,
        updatedAt: 1
      },
      {
        worktreeId: 'wt-2',
        requestedAgent: { hijacked: true } as unknown as TuiAgent,
        baseAgent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-2' },
        registeredAt: 1,
        updatedAt: 1
      }
    ])
    expect(store.resolveByOwnershipKey(OWNERSHIP)?.legacyLaunchConfig).toBeUndefined()
    expect(
      store.resolveByOwnershipKey({
        worktreeId: 'wt-2',
        baseAgent: 'codex',
        providerSessionId: 'sess-2'
      })
    ).toBeNull()
  })

  it('rehydrate enforces the providerSession.key ↔ base bind check and normalizes scalars (L2-#7)', () => {
    const store = new AgentSessionRecordStore()
    store.rebuildRecordsFrom([
      {
        worktreeId: 'wt-1',
        requestedAgent: 'claude',
        baseAgent: 'claude',
        // Wrong key type for a claude base (bind() would reject this pair);
        // it must be dropped at rehydrate, not replayed with wrong flags.
        providerSession: { key: 'conversation_id', id: 'conv-1' },
        registeredAt: 1,
        updatedAt: 1
      },
      {
        worktreeId: 'wt-1',
        requestedAgent: 'claude',
        baseAgent: 'claude',
        // Whitespace id normalizes; junk token/timestamps coerce.
        providerSession: { key: 'session_id', id: '  sess-1  ' },
        launchToken: 42 as unknown as string,
        registeredAt: 'yesterday' as unknown as number,
        updatedAt: Number.NaN
      }
    ])
    expect(
      store.resolveByOwnershipKey({
        worktreeId: 'wt-1',
        baseAgent: 'claude',
        providerSessionId: 'conv-1'
      })
    ).toBeNull()
    const record = store.resolveByOwnershipKey(OWNERSHIP)
    expect(record?.providerSession).toEqual({ key: 'session_id', id: 'sess-1' })
    expect(record?.launchToken).toBeUndefined()
    expect(record?.registeredAt).toBe(0)
    expect(record?.updatedAt).toBe(0)
  })
})
