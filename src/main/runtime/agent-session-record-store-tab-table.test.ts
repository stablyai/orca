/**
 * The persisted table from chat tab id to the conversation it shows, as the record store keeps it.
 * Separate from the store's main suite only because that file is at its line cap.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { isAgentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import {
  foundTestAgentSessionRecord,
  openTestAgentSessionRecordStore,
  readPersistedTestAgentSessionStore
} from './agent-session-record-store-test-harness'
import type { AgentSessionAtRestCreateRequest } from './agent-session-at-rest-create'

const NOW = 1_800_000_000_000
const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-tab-table-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

/** A chat's create, which is where a tab id is reserved. */
function create(
  store: AgentSessionRecordStore,
  overrides: Partial<Omit<AgentSessionAtRestCreateRequest, 'operation'>> = {}
) {
  return foundTestAgentSessionRecord(store, {
    sessionId: 'session-alpha',
    location: NATIVE,
    provider: 'claude',
    accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
    claimKeyId: 'key-1',
    now: NOW,
    ...overrides
  })
}

async function open(): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(directory)
}

describe('chat tab table', () => {
  const LEGACY_TAB_ID = 'structured-agent-session-session-alpha'

  it('takes a reserved id only when the tab is shown, and refuses it to a second chat', async () => {
    const store = await open()
    await create(store, { surfaceTabId: 'tab-alpha' })
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
      create(store, { sessionId: 'session-beta', surfaceTabId: 'tab-alpha' })
    ).rejects.toThrow('agent_session_conflict')
    expect(store.getRecord('session-beta')).toBeNull()
  })

  it('refuses showing a tab with the situation typed, as every chat refusal is', async () => {
    const store = await open()
    await create(store, { surfaceTabId: 'tab-alpha' })
    await store.setSessionTabVisibility('session-alpha', true, 'tab-alpha')
    await create(store, { sessionId: 'session-beta' })

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
    await create(store, { surfaceTabId: 'tab-alpha' })
    await store.setSessionTabVisibility('session-alpha', true, 'tab-alpha')
    await store.setSessionTabVisibility('session-alpha', false)
    await create(store, { sessionId: 'session-beta', surfaceTabId: 'tab-alpha' })
    await store.setSessionTabVisibility('session-beta', true, 'tab-alpha')
    expect(store.getSessionTabId('session-beta')).toBe('tab-alpha')
  })

  it('refuses a tab id that could not prefix a pane key', async () => {
    const store = await open()
    await expect(create(store, { surfaceTabId: 'agent-session:session-alpha' })).rejects.toThrow(
      'agent_session_operation_invalid'
    )
  })

  it('gives a shown chat the id clients derive, and puts a hidden one back under its old id', async () => {
    const store = await open()
    await create(store)
    await store.setSessionTabVisibility('session-alpha', true)
    expect(store.getSessionTabId('session-alpha')).toBe(LEGACY_TAB_ID)
    await store.setSessionTabVisibility('session-alpha', false)
    await store.setSessionTabVisibility('session-alpha', true, 'tab-restored')
    expect(store.getSessionTabId('session-alpha')).toBe('tab-restored')
  })
})
