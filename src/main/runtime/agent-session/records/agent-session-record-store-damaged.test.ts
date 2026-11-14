import { listStructuredProviderSessionOwnership } from '../../../native-chat/agent-session-wire/host/structured-provider-session-ownership'
import { findConflictingStructuredAdoption } from '../../../native-chat/conversation-adoption/structured-agent-session-history-adoption'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type {
  AgentSessionExecutionLocation,
  AgentSessionProcessIdentity,
  AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionProviderHandleLink } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from '../ownership/agent-session-reservation-admission'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

const NOW = 1_800_000_000_000
const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

const INDETERMINATE = { outcome: 'indeterminate', reason: 'no answer' } as const

let counter = 0

function operationId(now = NOW): string {
  counter += 1
  return `${now}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

function reserveRequest(
  overrides: Partial<AgentSessionReserveRequest> = {}
): AgentSessionReserveRequest {
  return {
    sessionId: 'session-alpha',
    location: NATIVE,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
    now: NOW,
    ...overrides
  }
}

function processIdentity(
  overrides: Partial<AgentSessionProcessIdentity> = {}
): AgentSessionProcessIdentity {
  return {
    hostId: 'local',
    pid: 4242,
    processStartTimeMs: 1_700_000_000_000,
    spawnToken: 'spawn-a',
    ...overrides
  }
}

function handleLink(
  overrides: Partial<AgentSessionProviderHandleLink> = {}
): AgentSessionProviderHandleLink {
  return {
    linkId: 'link-1',
    handle: claudeProviderHandle('provider-session-1', 'leaf-1'),
    origin: 'created',
    mintedAtFence: 1,
    observedAt: NOW,
    ...overrides
  }
}

let directory: string

async function open(hostId = 'local'): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory, { hostId })
}

/** Reserve, observe the spawn, prove the handle — the full path to an admitted writer. */
async function establishOwner(
  store: AgentSessionRecordStore,
  overrides: Partial<AgentSessionReserveRequest> = {}
): Promise<AgentSessionRecord> {
  const reserved = await store.reserveOwner(reserveRequest(overrides))
  const fence = reserved.record.lease.runtimeFence
  const sessionId = reserved.record.sessionId
  await store.commitProcessIdentity({
    sessionId,
    fence,
    process: processIdentity({ spawnToken: reserved.record.lease.reservedSpawnToken ?? 'spawn-a' }),
    now: NOW
  })
  return store.proveOwner({
    sessionId,
    fence,
    link: handleLink({ mintedAtFence: fence }),
    now: NOW
  })
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-store-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('damaged saved conversation observations', () => {
  it('retains the durable claim for a damaged owner in preflight and transactional adoption', async () => {
    const first = await open()
    await establishOwner(first)
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      Object.assign(persisted.records['session-alpha'].lease, { minimumNextFence: 'bad' })
    })
    const store = await open()
    const ownership = listStructuredProviderSessionOwnership(store.listConversations())
    expect(
      findConflictingStructuredAdoption({
        agent: 'claude',
        providerSessionId: 'provider-session-1',
        selfSessionId: 'session-beta',
        ownership
      })?.sessionId
    ).toBe('session-alpha')
    const adopted = reserveRequest({ sessionId: 'session-beta', adoptedHandleLink: handleLink() })
    await expect(store.founding.commit(adopted)).rejects.toMatchObject({
      refusal: {
        details: { reason: 'conversationHeldElsewhere' }
      }
    })
    await expect(store.reserveOwner(adopted)).rejects.toMatchObject({
      refusal: {
        details: { reason: 'conversationHeldElsewhere' }
      }
    })
    expect(store.getConversation('session-beta')).toBeNull()
  })

  it('persists a bounded advisory policy without exposing its artifact text in conversation metadata', async () => {
    const store = await open()
    const request = {
      ...reserveRequest(),
      advisoryPolicy: {
        schema: 1 as const,
        dataScope: 'published' as const,
        sourcePin: 'a'.repeat(40),
        deadlineAt: NOW + 300_000,
        maxModelCalls: 4,
        artifacts: [
          {
            path: 'note.txt',
            text: 'hello',
            sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
          }
        ]
      }
    }
    await store.founding.commit(request)
    request.advisoryPolicy.artifacts[0]!.text = 'changed input'
    expect(store.getRecord('session-alpha')?.advisoryPolicy?.artifacts[0]?.text).toBe('hello')
    const reopened = await open()
    expect(reopened.getRecord('session-alpha')?.schemaVersion).toBe(3)
    expect(reopened.getRecord('session-alpha')?.advisoryPolicy?.artifacts).toEqual([
      {
        path: 'note.txt',
        text: 'hello',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      }
    ])
    expect(JSON.stringify(reopened.listConversations())).not.toContain('hello')
    expect(reopened.getConversation('session-alpha')).not.toHaveProperty('advisoryPolicy')
  })

  it('retains an unreadable constrained record if its version is downgraded', async () => {
    const store = await open()
    await store.founding.commit(reserveRequest())
    await editPersistedTestAgentSessionStore(directory, (persisted) => {
      Object.assign(persisted.records['session-alpha'], {
        advisoryPolicy: {
          schema: 1,
          dataScope: 'published',
          sourcePin: 'a'.repeat(40),
          deadlineAt: NOW + 300_000,
          maxModelCalls: 4,
          artifacts: [
            {
              path: 'note.txt',
              text: 'hello',
              sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
            }
          ]
        }
      })
    })
    const reopened = await open()
    expect(reopened.getRecord('session-alpha')).toBeNull()
    expect(reopened.selectWritableRecord('session-alpha').kind).toBe('unreadable')
    await expect(reopened.reserveOwner(reserveRequest({ expectedFence: 1 }))).rejects.toMatchObject(
      { refusal: { code: 'execution_owner_reconciling', details: { reason: 'recordUnreadable' } } }
    )
  })

  it('does not grant a bounded advisor another owner after a proven exit and restart', async () => {
    const store = await open()
    await store.founding.commit({
      ...reserveRequest(),
      advisoryPolicy: {
        schema: 1,
        dataScope: 'published',
        sourcePin: 'a'.repeat(40),
        deadlineAt: NOW + 300_000,
        maxModelCalls: 4,
        artifacts: [
          {
            path: 'note.txt',
            text: 'hello',
            sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
          }
        ]
      }
    })
    const owner = await establishOwner(store, { expectedFence: 1 })
    const released = await store.evictProvenDeadOwner({
      sessionId: 'session-alpha',
      expectedFence: owner.lease.runtimeFence,
      probe: { outcome: 'pid-absent' },
      now: NOW + 100
    })
    const reopened = await open()
    await reopened.reconcileOnRestart({
      probe: async () => ({ outcome: 'pid-absent' }),
      now: NOW + 150
    })
    await expect(
      reopened.reserveOwner(
        reserveRequest({
          expectedFence: released.lease.runtimeFence,
          probe: { outcome: 'pid-absent' },
          now: NOW + 200
        })
      )
    ).rejects.toMatchObject({
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'advisoryAlreadyStarted' }
      }
    })
  })

  it('refuses first acquisition when an unstarted advisor deadline has passed', async () => {
    const store = await open()
    await store.founding.commit({
      ...reserveRequest(),
      advisoryPolicy: {
        schema: 1,
        dataScope: 'published',
        sourcePin: 'a'.repeat(40),
        deadlineAt: NOW + 100,
        maxModelCalls: 4,
        artifacts: [
          {
            path: 'note.txt',
            text: 'hello',
            sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
          }
        ]
      }
    })
    await expect(
      store.reserveOwner(reserveRequest({ expectedFence: 1, now: NOW + 200 }))
    ).rejects.toMatchObject({
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'advisoryDeadlinePassed' }
      }
    })
  })

  it.each([false, true])(
    'refuses adding or replacing an advisory policy on an existing record (%s)',
    async (bounded) => {
      const store = await open()
      const original = {
        schema: 1 as const,
        dataScope: 'published' as const,
        sourcePin: 'a'.repeat(40),
        deadlineAt: NOW + 300_000,
        maxModelCalls: 4,
        artifacts: [
          {
            path: 'note.txt',
            text: 'hello',
            sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
          }
        ]
      }
      await store.founding.commit({
        ...reserveRequest(),
        ...(bounded ? { advisoryPolicy: original } : {})
      })
      const replacement = {
        ...original,
        sourcePin: 'b'.repeat(40),
        artifacts: [
          {
            path: 'note.txt',
            text: 'world',
            sha256: '486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7'
          }
        ]
      }
      await expect(
        store.reserveOwner({ ...reserveRequest({ expectedFence: 1 }), advisoryPolicy: replacement })
      ).rejects.toMatchObject({
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { reason: 'advisoryPolicyMismatch' }
        }
      })
    }
  )
})
