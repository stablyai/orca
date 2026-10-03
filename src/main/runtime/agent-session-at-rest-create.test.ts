// A chat's create founds its record at rest, and is the only thing that does: adoption, the tab
// it reserves, and every refusal of a record that cannot be founded are decided here.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../shared/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../shared/agent-session-provider-handle'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS
} from '../../shared/agent-session-host-authority'
import {
  commitAgentSessionAtRestCreate,
  type AgentSessionAtRestCreateRequest
} from './agent-session-at-rest-create'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'

const NOW = 1_800_000_000_000
const SESSION = 'session-creating'
const LOCATION: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const ACCOUNT_HOME = { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/home/dev/.claude' }

let operations = 0
function operationId(): string {
  operations += 1
  return `${NOW}-${operations.toString(16).padStart(32, '0')}`
}

function createRequest(
  overrides: Partial<AgentSessionAtRestCreateRequest> = {}
): AgentSessionAtRestCreateRequest {
  return {
    sessionId: SESSION,
    location: LOCATION,
    provider: 'claude',
    accountHome: ACCOUNT_HOME,
    claimKeyId: 'key-1',
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-create' },
    now: NOW,
    ...overrides
  }
}

function storeState(records: readonly AgentSessionRecord[] = []): AgentSessionStoreState {
  return {
    schemaVersion: 2,
    hostId: 'local',
    records: new Map(records.map((record) => [record.sessionId, record])),
    operations: new Map(),
    retiredClaimKeys: [],
    unreadableRecords: new Map(),
    sessionTabs: null
  }
}

function adoptedLink(
  overrides: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId: 'claude-1-provider-session-alpha-1-empty',
    handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: null },
    origin: 'adopted',
    mintedAtFence: 1,
    observedAt: NOW,
    ...overrides
  }
}

/** Another chat whose agent already ran the conversation `adoptedLink` names, on another leaf. */
function holderOfAdoptedConversation(): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: 'session-holder' })),
    providerHandleChain: [
      adoptedLink({
        linkId: 'claude-1-provider-session-alpha-1-leaf',
        handle: { provider: 'claude', sessionId: 'provider-session-alpha-1', leafUuid: 'leaf-1' },
        origin: 'created'
      })
    ]
  }
}

describe('a create at rest', () => {
  it('founds a released record at fence 1 with an empty chain, so its first start is fresh', () => {
    const state = storeState()
    const { record, replayed } = commitAgentSessionAtRestCreate(state, createRequest())

    expect(replayed).toBe(false)
    expect(record.providerHandleChain).toEqual([])
    expect(record.lease).toMatchObject({
      runtimeFence: 1,
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: null
    })
    expect(state.records.get(SESSION)).toEqual(record)
    // Settled by the create once its journal is open; see structured-agent-session-create-at-rest.
    expect([...state.operations.values()].map((row) => row.outcome)).toEqual([
      { status: 'pending' }
    ])
  })

  it('replays the record its own operation founded, and writes nothing more', () => {
    const state = storeState()
    const request = createRequest()
    const first = commitAgentSessionAtRestCreate(state, request)

    const replay = commitAgentSessionAtRestCreate(state, { ...request, now: NOW + 1 })

    expect(replay).toMatchObject({ replayed: true, record: first.record })
    expect(state.operations.size).toBe(1)
  })

  it('refuses a second create of a session that exists', () => {
    const state = storeState()
    commitAgentSessionAtRestCreate(state, createRequest())

    expect(() => commitAgentSessionAtRestCreate(state, createRequest())).toThrow(
      expect.objectContaining({
        refusal: expect.objectContaining({
          code: 'agent_session_conflict',
          details: { reason: 'sessionExists' }
        })
      })
    )
  })

  it('refuses a session whose record this build cannot read, as reconciling', () => {
    const state = storeState()
    state.unreadableRecords.set(SESSION, { reason: 'invalid', raw: {} })

    expect(() => commitAgentSessionAtRestCreate(state, createRequest())).toThrow(
      expect.objectContaining({
        refusal: expect.objectContaining({
          code: 'execution_owner_reconciling',
          details: { reason: 'recordUnreadable' }
        })
      })
    )
    expect(state.records.size).toBe(0)
  })

  it('refuses launch args or options it cannot store, before founding anything', () => {
    const state = storeState()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a malformed payload the store must refuse.
    const launchArgs = [42] as unknown as string[]
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a malformed payload the store must refuse.
    const options = { model: 7 } as unknown as Record<string, string>

    expect(() => commitAgentSessionAtRestCreate(state, createRequest({ launchArgs }))).toThrow(
      'agent_session_launch_args_invalid'
    )
    expect(() => commitAgentSessionAtRestCreate(state, createRequest({ options }))).toThrow(
      'agent_session_options_invalid'
    )
    expect(state.records.size).toBe(0)
  })
})

/** What a create on an older host left when the start it ran at create failed: released at the
 *  fence that start reserved, its exit proven, no conversation bound. */
function failedCreateFromOlderHost(
  overrides: Partial<AgentSessionRecord> = {}
): AgentSessionRecord {
  return {
    ...agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: SESSION,
        runtimeKind: 'native',
        runtimeFence: 2,
        provenHandleLinkId: null,
        ownerProcess: null,
        reservedSpawnToken: null,
        claimStatus: 'released',
        deathEvidence: { kind: 'exit-observed', detail: 'the create failed', observedAt: 1 }
      })
    ),
    location: LOCATION,
    accountHome: ACCOUNT_HOME,
    providerHandleChain: [],
    conversationName: 'Fix the flaky test',
    ...overrides
  }
}

describe('a create over a record an older host left after its start failed', () => {
  it('founds it again at rest, at the next fence, keeping its name', () => {
    const existing = failedCreateFromOlderHost()
    const state = storeState([existing])

    const { record, replayed } = commitAgentSessionAtRestCreate(state, createRequest())

    expect(replayed).toBe(false)
    expect(record).toMatchObject({
      providerHandleChain: [],
      conversationName: 'Fix the flaky test',
      createdAt: existing.createdAt
    })
    expect(record.lease).toMatchObject({
      runtimeFence: 3,
      claimStatus: 'released',
      handoffStage: null,
      deathEvidence: null
    })
  })

  it('keeps the floor a recovered copy set, and mints the fence past it', () => {
    const exited = failedCreateFromOlderHost().lease
    const state = storeState([
      failedCreateFromOlderHost({ lease: { ...exited, minimumNextFence: 9 } })
    ])

    const { record } = commitAgentSessionAtRestCreate(state, createRequest())

    expect(record.lease).toMatchObject({ runtimeFence: 9, minimumNextFence: 9 })
  })

  it('refuses while this host has not yet adjudicated the lease', () => {
    const exited = failedCreateFromOlderHost().lease
    const state = storeState([
      failedCreateFromOlderHost({ lease: { ...exited, unreconciled: true } })
    ])

    expect(() => commitAgentSessionAtRestCreate(state, createRequest())).toThrow(
      expect.objectContaining({
        refusal: expect.objectContaining({
          code: 'execution_owner_reconciling',
          details: { reason: 'hostReconciling' }
        })
      })
    )
  })

  it('refuses one that bound a conversation, may still run, or is another identity', () => {
    const exited = failedCreateFromOlderHost().lease
    const records = [
      failedCreateFromOlderHost({ providerHandleChain: [adoptedLink({ mintedAtFence: 2 })] }),
      failedCreateFromOlderHost({
        lease: { ...exited, claimStatus: 'reserved', handoffStage: 'recovering' }
      }),
      // Released so a send can start over, but nothing proved the attempt gone.
      failedCreateFromOlderHost({ lease: { ...exited, deathEvidence: null } }),
      failedCreateFromOlderHost({
        accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' }
      })
    ]
    for (const record of records) {
      expect(() => commitAgentSessionAtRestCreate(storeState([record]), createRequest())).toThrow(
        expect.objectContaining({
          refusal: expect.objectContaining({ details: { reason: 'sessionExists' } })
        })
      )
    }
    // An adoption never takes over a record: it names a conversation of its own.
    expect(() =>
      commitAgentSessionAtRestCreate(
        storeState([failedCreateFromOlderHost()]),
        createRequest({ adoptedHandleLink: adoptedLink() })
      )
    ).toThrow(
      expect.objectContaining({
        refusal: expect.objectContaining({ details: { reason: 'sessionExists' } })
      })
    )
  })
})

describe('a create retried after its operation row aged out', () => {
  const LATER =
    NOW + AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS + AGENT_SESSION_OPERATION_FUTURE_SKEW_MS + 1

  it('answers the record it founded, at rest, under a fresh row the create settles', () => {
    const state = storeState()
    const request = createRequest()
    const { record } = commitAgentSessionAtRestCreate(state, request)

    const retried = commitAgentSessionAtRestCreate(state, { ...request, now: LATER })

    expect(retried).toMatchObject({ replayed: true, record })
    expect(retried.operationRow).toMatchObject({
      operationId: request.operation.operationId,
      outcome: { status: 'pending' }
    })
    expect(retried.operationRow.expiresAt).toBeGreaterThan(LATER)
  })

  it('stays expired for a record that is not the one this create founded', () => {
    const request = createRequest()
    const otherHome = { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/home/dev/.claude-work' }
    for (const founded of [
      createRequest({ ...request, accountHome: otherHome }),
      createRequest({ ...request, adoptedHandleLink: adoptedLink() })
    ]) {
      const state = storeState()
      commitAgentSessionAtRestCreate(state, founded)
      expect(() => commitAgentSessionAtRestCreate(state, { ...request, now: LATER })).toThrow(
        expect.objectContaining({
          refusal: expect.objectContaining({ code: 'agent_session_operation_expired' })
        })
      )
    }
  })
})

describe('an adopting create at rest', () => {
  it('seeds the chain with the adopted link alone, at the record fence its first start moves', () => {
    const link = adoptedLink()
    const { record } = commitAgentSessionAtRestCreate(
      storeState(),
      createRequest({ adoptedHandleLink: link })
    )

    expect(record.providerHandleChain).toEqual([link])
    expect(record.lease.runtimeFence).toBe(link.mintedAtFence)
  })

  it('refuses a conversation another record already holds, by its root', () => {
    // The held link names a leaf; the adoption names none. Keying on the exact handle would let two
    // writers onto one conversation on different branches.
    const state = storeState([holderOfAdoptedConversation()])

    expect(() =>
      commitAgentSessionAtRestCreate(state, createRequest({ adoptedHandleLink: adoptedLink() }))
    ).toThrow(
      expect.objectContaining({
        refusal: expect.objectContaining({
          code: 'agent_session_conflict',
          details: { reason: 'conversationHeldElsewhere' }
        })
      })
    )
    expect(state.records.has(SESSION)).toBe(false)
  })

  it('admits a conversation no record holds', () => {
    const state = storeState([holderOfAdoptedConversation()])
    const other = adoptedLink({
      handle: { provider: 'claude', sessionId: 'provider-session-other', leafUuid: null }
    })

    expect(
      commitAgentSessionAtRestCreate(state, createRequest({ adoptedHandleLink: other })).record
        .providerHandleChain
    ).toEqual([other])
  })
})

describe('the tab a create reserves', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-at-rest-create-tab-'))
  })
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('takes no tab at create, then answers a replay naming another tab with the one it was given', async () => {
    const store = await openTestAgentSessionRecordStore(directory)
    const request = createRequest({ surfaceTabId: 'chat-tab-1' })
    await store.createAtRest(request)
    // Publishing the tab takes the id, so a create that never gets there leaves nothing behind.
    expect(store.getSessionTabId(SESSION)).toBeNull()

    await store.setSessionTabVisibility(SESSION, true, 'chat-tab-1')
    expect(await store.createAtRest({ ...request, surfaceTabId: 'chat-tab-2' })).toMatchObject({
      replayed: true
    })
    expect(store.getSessionTabId(SESSION)).toBe('chat-tab-1')
  })

  it("refuses a tab id another session's tab holds, and a malformed one", async () => {
    const store = await openTestAgentSessionRecordStore(directory)
    await store.createAtRest(createRequest({ surfaceTabId: 'chat-tab-1' }))
    await store.setSessionTabVisibility(SESSION, true, 'chat-tab-1')

    await expect(
      store.createAtRest(createRequest({ sessionId: 'session-other', surfaceTabId: 'chat-tab-1' }))
    ).rejects.toMatchObject({ refusal: { code: 'agent_session_conflict' } })
    await expect(
      store.createAtRest(createRequest({ sessionId: 'session-other', surfaceTabId: '' }))
    ).rejects.toMatchObject({ refusal: { code: 'agent_session_operation_invalid' } })
    expect(store.getRecord('session-other')).toBeNull()
  })
})
