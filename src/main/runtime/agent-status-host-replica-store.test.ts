import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import type {
  AgentStatusStoreDelta,
  AgentStatusStoreSnapshot
} from '../../shared/agent-status-store-replication'
import { AgentStatusHostReplicaStore } from './agent-status-host-replica-store'

function row(
  paneKey: string,
  state: AgentStatusIpcPayload['state'] = 'working',
  revision = 1,
  receivedAt = 1
): AgentStatusIpcPayload {
  return {
    paneKey,
    connectionId: null,
    receivedAt,
    stateStartedAt: receivedAt,
    state,
    prompt: '',
    observation: {
      origin: 'hook',
      authorityId: 'remote-authority',
      incarnation: 1,
      revision,
      observedAt: receivedAt
    }
  }
}

function snapshot(
  executionHostId: AgentStatusStoreSnapshot['executionHostId'],
  overrides: Partial<AgentStatusStoreSnapshot> = {}
): AgentStatusStoreSnapshot {
  return {
    type: 'snapshot',
    executionHostId,
    ownerEpoch: 'epoch-a',
    cursor: 0,
    complete: true,
    rows: [],
    ...overrides
  }
}

function delta(
  executionHostId: AgentStatusStoreDelta['executionHostId'],
  overrides: Partial<AgentStatusStoreDelta> = {}
): AgentStatusStoreDelta {
  return {
    type: 'delta',
    executionHostId,
    ownerEpoch: 'epoch-a',
    previousCursor: 0,
    cursor: 1,
    changes: [],
    ...overrides
  }
}

describe('AgentStatusHostReplicaStore', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces complete membership for only the scoped host', () => {
    const store = new AgentStatusHostReplicaStore()
    store.apply(snapshot('ssh:first', { rows: [row('first-a'), row('first-b')] }), {
      executionHostId: 'ssh:first',
      connectionId: 'first'
    })
    store.apply(snapshot('ssh:second', { rows: [row('second-a')] }), {
      executionHostId: 'ssh:second',
      connectionId: 'second'
    })

    store.apply(snapshot('ssh:first', { cursor: 1, rows: [] }), {
      executionHostId: 'ssh:first',
      connectionId: 'first'
    })

    expect(store.getHostSnapshot('ssh:first').rows).toEqual([])
    expect(store.getHostSnapshot('ssh:second').rows).toEqual([
      expect.objectContaining({ paneKey: 'second-a', connectionId: 'second' })
    ])
  })

  it('retains omitted rows through an incomplete census', () => {
    const store = new AgentStatusHostReplicaStore()
    const routing = { executionHostId: 'ssh:first' as const, connectionId: 'first' }
    store.apply(snapshot('ssh:first', { rows: [row('a'), row('b')] }), routing)

    store.apply(
      snapshot('ssh:first', {
        cursor: 1,
        complete: false,
        rows: [row('a', 'waiting', 2)]
      }),
      routing
    )

    expect(store.getHostSnapshot('ssh:first')).toMatchObject({
      membershipConfirmed: false,
      rows: [
        expect.objectContaining({ paneKey: 'a', state: 'waiting' }),
        expect.objectContaining({ paneKey: 'b', state: 'working' })
      ]
    })
  })

  it('retains rows and unconfirms membership across gaps and owner restarts', () => {
    const store = new AgentStatusHostReplicaStore()
    const routing = { executionHostId: 'ssh:first' as const, connectionId: 'first' }
    store.apply(snapshot('ssh:first', { rows: [row('a')] }), routing)

    expect(store.apply(delta('ssh:first', { previousCursor: 1, cursor: 2 }), routing)).toBe(
      'resnapshot-required'
    )
    expect(
      store.apply(
        delta('ssh:first', { ownerEpoch: 'epoch-b', previousCursor: 2, cursor: 3 }),
        routing
      )
    ).toBe('resnapshot-required')
    expect(store.getHostSnapshot('ssh:first')).toMatchObject({
      ownerEpoch: 'epoch-b',
      cursor: null,
      membershipConfirmed: false,
      rows: [expect.objectContaining({ paneKey: 'a' })]
    })
  })

  it('rejects frames from a different execution host', () => {
    const store = new AgentStatusHostReplicaStore()
    const mutations = vi.fn()
    store.subscribeStatusRowMutations(mutations)

    expect(
      store.apply(snapshot('ssh:other', { rows: [row('wrong')] }), {
        executionHostId: 'ssh:expected',
        connectionId: 'expected'
      })
    ).toBe('wrong-host')
    expect(store.getStatusSnapshot()).toEqual([])
    expect(mutations).not.toHaveBeenCalled()
  })

  it('keeps a waiting row on contact loss and removes it only on explicit abandon', () => {
    const store = new AgentStatusHostReplicaStore()
    store.apply(snapshot('ssh:first', { rows: [row('question', 'waiting')] }), {
      executionHostId: 'ssh:first',
      connectionId: 'first'
    })

    store.setContact('ssh:first', 'unverifiable')
    expect(store.getHostSnapshot('ssh:first')).toMatchObject({
      contact: 'unverifiable',
      rows: [expect.objectContaining({ paneKey: 'question', state: 'waiting' })]
    })

    store.abandonHost('ssh:first')
    expect(store.getHostSnapshot('ssh:first')).toMatchObject({
      contact: 'unverifiable',
      membershipConfirmed: false,
      rows: []
    })
  })

  it('uses a stable replica clock for duplicate evidence and advances it for new evidence', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const store = new AgentStatusHostReplicaStore()
    const routing = { executionHostId: 'ssh:first' as const, connectionId: 'first' }
    store.apply(snapshot('ssh:first', { rows: [row('a', 'working', 1, 99_000)] }), routing)
    const first = store.getHostSnapshot('ssh:first').rows[0]

    vi.setSystemTime(5_000)
    store.apply(
      snapshot('ssh:first', { cursor: 1, rows: [row('a', 'working', 1, 99_000)] }),
      routing
    )
    const duplicate = store.getHostSnapshot('ssh:first').rows[0]

    vi.setSystemTime(7_000)
    store.apply(
      snapshot('ssh:first', { cursor: 2, rows: [row('a', 'waiting', 2, -99_000)] }),
      routing
    )
    const changed = store.getHostSnapshot('ssh:first').rows[0]

    expect(first).toMatchObject({ receivedAt: 1_000, replicaEvidenceReceivedAt: 1_000 })
    expect(duplicate).toMatchObject({ receivedAt: 1_000, replicaEvidenceReceivedAt: 1_000 })
    expect(changed).toMatchObject({
      state: 'waiting',
      receivedAt: 7_000,
      replicaEvidenceReceivedAt: 7_000
    })
  })
})
