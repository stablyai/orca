import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session/lifecycle/agent-session-record'

import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  closeTestAgentSessionRecordStores,
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore,
  withTestAgentSessionDatabase
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
  await closeTestAgentSessionRecordStores()
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
  it('keeps an observable record in its tab when its lease has an unknown write requirement', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest())
    await withTestAgentSessionDatabase(directory, (db) =>
      db
        .prepare(
          `UPDATE agent_session_records SET record_json=json_set(record_json,'$.lease.minimumNextFence','future-floor') WHERE session_id=?`
        )
        .run('session-alpha')
    )
    const reopened = await open()
    await reopened.setSessionTabVisibility('session-alpha', true, 'tab-alpha')
    expect(reopened.getSessionTabId('session-alpha')).toBe('tab-alpha')
    expect((await readPersistedTestAgentSessionStore(directory)).sessionTabs).toEqual([
      { tabId: 'tab-alpha', sessionId: 'session-alpha' }
    ])
    await expect(reopened.setConversationName('session-alpha', 'changed')).rejects.toThrow()
  })

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
