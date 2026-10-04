/**
 * The persisted table from chat tab id to the conversation it shows, as the record store keeps it.
 * Separate from the store's main suite only because that file is at its line cap.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

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
  const LEGACY_TAB_ID = 'structured-agent-session-session-alpha'

  it('takes a reserved id only when the tab is shown, and refuses it to a second chat', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest({ surfaceTabId: 'tab-alpha' }))
    // A create that dies before its tab is shown leaves nothing to restore or release.
    expect(store.getSessionTabId('session-alpha')).toBeNull()
    expect((await readPersistedTestAgentSessionStore(directory)).sessionTabs).toBeUndefined()

    await store.setSessionTabVisibility('session-alpha', true, 'tab-alpha')
    expect(store.getSessionTabId('session-alpha')).toBe('tab-alpha')
    const persisted = await readPersistedTestAgentSessionStore(directory)
    expect(persisted.sessionTabs).toEqual([{ tabId: 'tab-alpha', sessionId: 'session-alpha' }])
    // Not copied onto the record: the table is the one place the id lives.
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

  it('refuses showing a tab with the situation typed, as every chat refusal is', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest({ surfaceTabId: 'tab-alpha' }))
    await store.setSessionTabVisibility('session-alpha', true, 'tab-alpha')
    await store.reserveOwner(
      reserveRequest({
        sessionId: 'session-beta',
        operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
      })
    )

    // The message stays the code: readers of a thrown refusal treat it as one.
    await expect(
      store.setSessionTabVisibility('session-beta', true, 'tab-alpha')
    ).rejects.toSatisfy(
      (error) =>
        isAgentSessionRefusalError(error) &&
        error.message === 'agent_session_conflict' &&
        error.refusal.details?.reason === 'tabIdTaken'
    )
    await expect(store.setSessionTabVisibility('session-gone', true)).rejects.toSatisfy(
      (error) =>
        isAgentSessionRefusalError(error) &&
        error.message === 'agent_session_identity_required' &&
        error.refusal.details?.reason === 'recordMissing'
    )
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

  it('refuses a tab id that could not prefix a pane key', async () => {
    const store = await open()
    await expect(
      store.reserveOwner(reserveRequest({ surfaceTabId: 'agent-session:session-alpha' }))
    ).rejects.toThrow('agent_session_operation_invalid')
  })

  it('gives a shown chat the id clients derive, and puts a hidden one back under its old id', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest())
    await store.setSessionTabVisibility('session-alpha', true)
    expect(store.getSessionTabId('session-alpha')).toBe(LEGACY_TAB_ID)
    await store.setSessionTabVisibility('session-alpha', false)
    await store.setSessionTabVisibility('session-alpha', true, 'tab-restored')
    expect(store.getSessionTabId('session-alpha')).toBe('tab-restored')
  })
})
