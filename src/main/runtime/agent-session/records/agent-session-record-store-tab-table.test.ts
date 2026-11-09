import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session/lifecycle/agent-session-lease-adjudication'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'

import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { pickAgentSessionOption } from './agent-session-record-options'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import type { AgentSessionReserveRequest } from '../ownership/agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}
const INDETERMINATE: AgentSessionOwnerProbe = { outcome: 'indeterminate', reason: 'no answer' }

let directory: string
let counter = 0

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-tab-table-'))
})

afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

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

async function open(): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory)
}

describe('chat tab table', () => {
  it('takes a reserved id only when the tab is shown, and refuses it to a second chat', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest({ surfaceTabId: 'tab-alpha' }))
    expect(store.getSessionTabId('session-alpha')).toBeNull()
    expect((await readPersistedTestAgentSessionStore(directory)).sessionTabs).toBeUndefined()

    await store.setSessionTabVisibility('session-alpha', true, 'tab-alpha')
    expect(store.getSessionTabId('session-alpha')).toBe('tab-alpha')
    const persisted = await readPersistedTestAgentSessionStore(directory)
    expect(persisted.sessionTabs).toEqual([{ tabId: 'tab-alpha', sessionId: 'session-alpha' }])
    // The tab table is authoritative; never duplicate its id onto session records.
    expect(persisted.records['session-alpha']).not.toHaveProperty('surfaceTabId')

    await expect(
      store.reserveOwner(
        reserveRequest({
          sessionId: 'session-beta',
          surfaceTabId: 'tab-alpha',
          operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
        })
      )
    ).rejects.toThrow('agent_session_conflict')
    expect(store.getRecord('session-beta')).toBeNull()
  })

  it('frees a reserved id once its chat is hidden', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest({ surfaceTabId: 'tab-alpha' }))
    await store.setSessionTabVisibility('session-alpha', true, 'tab-alpha')
    await store.setSessionTabVisibility('session-alpha', false)
    await store.reserveOwner(
      reserveRequest({
        sessionId: 'session-beta',
        surfaceTabId: 'tab-alpha',
        operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
      })
    )
    await store.setSessionTabVisibility('session-beta', true, 'tab-alpha')
    expect(store.getSessionTabId('session-beta')).toBe('tab-alpha')
  })
})

describe('Ultracode across a restart and a closed tab', () => {
  it('turns a legacy saved preset off, and accepts the preset again from an older client', async () => {
    const record = { ...agentSessionRecordFixture(), options: { effort: 'ultracode' } }
    await seedTestAgentSessionRecordStore(directory, {
      records: [record],
      sessionTabs: [{ tabId: 'tab-alpha', sessionId: record.sessionId }]
    })
    const store = await open()
    const picked = { sessionId: record.sessionId, fence: 7, models: undefined, now: NOW }
    await store.reviseSessionOptions(pickAgentSessionOption, {
      ...picked,
      key: 'ultracode',
      value: 'false'
    })
    expect(store.getRecord(record.sessionId)?.options).toEqual({
      effort: 'xhigh',
      ultracode: 'false'
    })
    await store.reviseSessionOptions(pickAgentSessionOption, {
      ...picked,
      key: 'effort',
      value: 'ultracode'
    })
    expect(store.getRecord(record.sessionId)?.options).toEqual({
      effort: 'ultracode'
    })
    await store.reviseSessionOptions(pickAgentSessionOption, {
      ...picked,
      key: 'effort',
      value: 'xhigh'
    })
    expect(store.getRecord(record.sessionId)?.options).toEqual({ effort: 'xhigh' })
  })

  it.each([
    [
      { model: 'opus', effort: 'high', ultracode: 'true' },
      { model: 'opus', effort: 'high' }
    ],
    [
      { model: 'opus', effort: 'ultracode' },
      { model: 'opus', effort: 'xhigh' }
    ]
  ])('keeps %o while its tab stays open, and closing the tab leaves %o', async (saved, closed) => {
    const record = { ...agentSessionRecordFixture(), options: saved }
    await seedTestAgentSessionRecordStore(directory, {
      records: [record],
      sessionTabs: [{ tabId: 'tab-alpha', sessionId: record.sessionId }]
    })
    const restarted = await open()
    expect(restarted.isSessionTabVisible(record.sessionId)).toBe(true)
    expect(restarted.getRecord(record.sessionId)?.options).toEqual(saved)

    await restarted.setSessionTabVisibility(record.sessionId, false)
    expect(restarted.getRecord(record.sessionId)?.options).toEqual(closed)
    expect(
      (await readPersistedTestAgentSessionStore(directory)).records[record.sessionId]?.options
    ).toEqual(closed)
    await restarted.setSessionTabVisibility(record.sessionId, true)
    expect(restarted.getRecord(record.sessionId)?.options).toEqual(closed)
  })

  it('reopens a chat closed by an older build without its saved Ultracode preset', async () => {
    const record = {
      ...agentSessionRecordFixture(),
      options: { model: 'opus', effort: 'ultracode' }
    }
    await seedTestAgentSessionRecordStore(directory, { records: [record], sessionTabs: [] })
    const store = await open()
    await store.setSessionTabVisibility(record.sessionId, true)
    expect(store.getRecord(record.sessionId)?.options).toEqual({ model: 'opus', effort: 'xhigh' })
  })
})
