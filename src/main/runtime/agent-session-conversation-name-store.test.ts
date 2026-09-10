import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAgentSessionRecord } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const SESSION = 'session-conversation-name'
let directory: string

function request(): AgentSessionReserveRequest {
  return {
    sessionId: SESSION,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    runtimeKind: 'native',
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'reservation-unused' },
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-00000000000000000000000000000001`,
      fingerprint: 'fp-1'
    },
    now: NOW
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-conversation-name-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('agent session conversation name', () => {
  it('survives a store reopen so a restart relabels the tab without asking the provider', async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await store.reserveOwner(request())

    await store.applyConversationNaming(
      SESSION,
      { conversationName: 'Fix the lease probe' },
      NOW + 1
    )

    const reopened = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    expect(reopened.getRecord(SESSION)?.conversationName).toBe('Fix the lease probe')
  })

  it('leaves the record untouched when the name it is given is the stored one', async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    await store.reserveOwner(request())
    const named = await store.applyConversationNaming(
      SESSION,
      { conversationName: 'Fix the lease probe' },
      NOW + 1
    )

    const again = await store.applyConversationNaming(
      SESSION,
      { conversationName: 'Fix the lease probe' },
      NOW + 2
    )

    expect(again.updatedAt).toBe(named.updatedAt)
  })

  it('refuses a name for a session that has no record', async () => {
    const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })

    await expect(
      store.applyConversationNaming('missing-session', { conversationName: 'name' }, NOW)
    ).rejects.toThrow('agent_session_identity_required')
  })
})

describe('isAgentSessionRecord conversation name', () => {
  function recordWith(conversationName: unknown): unknown {
    return {
      schemaVersion: 2,
      sessionId: SESSION,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      providerHandleChain: [],
      accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
      conversationName,
      lease: {
        sessionId: SESSION,
        runtimeKind: 'native',
        runtimeFence: 1,
        handoffStage: null,
        provenHandleLinkId: null,
        ownerProcess: null,
        reservedSpawnToken: 'spawn-a',
        leaseDeadlineAt: NOW,
        lastRenewedAt: NOW,
        handoffOperationId: null,
        journalCheckpoint: null,
        claimKeyId: 'key-1',
        claimStatus: 'reserved',
        unreconciled: false,
        deathEvidence: null
      },
      createdAt: NOW,
      updatedAt: NOW
    }
  }

  it('accepts a bounded name and an absent one', () => {
    expect(isAgentSessionRecord(recordWith('Fix the lease probe'))).toBe(true)
    expect(isAgentSessionRecord(recordWith(undefined))).toBe(true)
  })

  it('rejects an empty, oversized, or non-string name rather than loading it', () => {
    expect(isAgentSessionRecord(recordWith(''))).toBe(false)
    expect(isAgentSessionRecord(recordWith('a'.repeat(201)))).toBe(false)
    expect(isAgentSessionRecord(recordWith(7))).toBe(false)
  })
})
