// A /clear's one store write: the conversation it continues in, founded at rest, and the marker
// on the cleared record that points there. Either both land, on disk too, or neither does.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'

const NOW = 1_800_000_000_000
const SOURCE = 'session-alpha'
const REPLACEMENT = `clear-${'a'.repeat(40)}`
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-clear-commit-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const open = () => openTestAgentSessionRecordStore(directory)

async function storeWithSource(): Promise<AgentSessionRecordStore> {
  const store = await open()
  await store.reserveOwner({
    sessionId: SOURCE,
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    },
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    options: { model: 'sonnet' },
    expectedFence: null,
    spawnToken: 'spawn-a',
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: INDETERMINATE,
    operation: {
      callerKey: 'client-1',
      operationId: `${NOW}-${'1'.repeat(32)}`,
      fingerprint: 'fp'
    },
    now: NOW
  })
  await store.setSessionTabVisibility(SOURCE, true, 'tab-alpha')
  return store
}

function marker(fence: number, replacementSessionId = REPLACEMENT) {
  return {
    command: 'clear' as const,
    state: 'completed' as const,
    phase: 'committed' as const,
    runtimeFence: fence,
    operationId: `${NOW}-${'2'.repeat(32)}`,
    callerKey: 'client-1',
    replacementSessionId
  }
}

describe("a /clear's commit", () => {
  it('founds the replacement at rest and points the cleared record at it, on disk', async () => {
    const store = await storeWithSource()
    const fence = store.getRecord(SOURCE)!.lease.runtimeFence
    await store.commitConversationClear({
      sessionId: SOURCE,
      fence,
      command: marker(fence),
      claimKeyId: 'key-1',
      now: NOW + 5
    })

    const reopened = await open()
    const source = reopened.getRecord(SOURCE)!
    expect(source.conversationCommand).toEqual(marker(fence))
    expect(reopened.getRecord(REPLACEMENT)).toEqual({
      schemaVersion: source.schemaVersion,
      sessionId: REPLACEMENT,
      location: source.location,
      provider: 'claude',
      accountHome: source.accountHome,
      options: { model: 'sonnet' },
      providerHandleChain: [],
      createdAt: NOW + 5,
      updatedAt: NOW + 5,
      lease: {
        sessionId: REPLACEMENT,
        runtimeKind: 'native',
        runtimeFence: 1,
        handoffStage: null,
        provenHandleLinkId: null,
        ownerProcess: null,
        reservedSpawnToken: null,
        leaseDeadlineAt: NOW + 5,
        lastRenewedAt: NOW + 5,
        handoffOperationId: null,
        journalCheckpoint: null,
        claimKeyId: 'key-1',
        claimStatus: 'released',
        // Loading marks every lease for this host's adjudication, as it does any record's.
        unreconciled: true,
        deathEvidence: null
      }
    })
    expect(reopened.getSessionTabId(REPLACEMENT)).toBe('tab-alpha')
    expect(reopened.getSessionTabId(SOURCE)).toBeNull()
  })

  it('writes neither the replacement nor the marker when the commit is refused', async () => {
    const store = await storeWithSource()
    const fence = store.getRecord(SOURCE)!.lease.runtimeFence
    // The source's lease moved after the clear read it: the marker's fenced write refuses.
    const refused = await store
      .commitConversationClear({
        sessionId: SOURCE,
        fence: fence + 1,
        command: marker(fence + 1),
        claimKeyId: 'key-1',
        now: NOW
      })
      .catch((error: unknown) => error)
    expect(isAgentSessionRefusalError(refused)).toBe(true)

    for (const each of [store, await open()]) {
      expect(each.getRecord(REPLACEMENT)).toBeNull()
      expect(each.getRecord(SOURCE)?.conversationCommand).toBeUndefined()
      expect(each.getSessionTabId(SOURCE)).toBe('tab-alpha')
      expect(each.listRecords().map((record) => record.sessionId)).toEqual([SOURCE])
    }
  })

  it('never overwrites a record already under the replacement id', async () => {
    const store = await storeWithSource()
    const fence = store.getRecord(SOURCE)!.lease.runtimeFence
    const before = store.getRecord(SOURCE)!
    const refused = await store
      .commitConversationClear({
        sessionId: SOURCE,
        fence,
        command: marker(fence, SOURCE),
        claimKeyId: 'key-1',
        now: NOW
      })
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({
      refusal: { code: 'agent_session_conflict', details: { reason: 'sessionExists' } }
    })
    expect(store.getRecord(SOURCE)).toEqual(before)
  })
})
