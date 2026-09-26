/**
 * The persisted table from chat tab id to the conversation it shows, as the record store keeps it.
 * Separate from the store's main suite only because that file is at its line cap.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentSessionOwnerProbe } from '../../shared/agent-session-lease-adjudication'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'
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
  return AgentSessionRecordStore.open({ directory, hostId: 'local' })
}

describe('chat tab table', () => {
  const LEGACY_TAB_ID = 'structured-agent-session-session-alpha'
  const filePath = () => agentSessionStorePath(directory)
  const readFileJson = async () => JSON.parse(await readFile(filePath(), 'utf-8'))

  it('takes a reserved id only when the tab is shown, and refuses it to a second chat', async () => {
    const store = await open()
    await store.reserveOwner(reserveRequest({ surfaceTabId: 'tab-alpha' }))
    // A create that dies before its tab is shown leaves nothing to restore or release.
    expect(store.getSessionTabId('session-alpha')).toBeNull()
    expect((await readFileJson()).sessionTabs).toBeUndefined()

    await store.setSessionTabVisibility('session-alpha', true, 'tab-alpha')
    expect(store.getSessionTabId('session-alpha')).toBe('tab-alpha')
    const persisted = await readFileJson()
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

  it('seeds the table from an older store, keeping each visible chat on the id it has today', async () => {
    const first = await open()
    await first.reserveOwner(reserveRequest())
    await first.reserveOwner(
      reserveRequest({
        sessionId: 'session-beta',
        operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-2' }
      })
    )
    await first.reserveOwner(
      reserveRequest({
        sessionId: 'session-gamma',
        operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-3' }
      })
    )
    // What a build before the table wrote: the visible list, and a tab id on some records.
    const raw = await readFileJson()
    delete raw.sessionTabs
    raw.visibleSessionIds = ['session-alpha', 'session-beta']
    raw.records['session-alpha'].surfaceTabId = 'tab-alpha'
    raw.records['session-beta'].surfaceTabId = 'structured-agent-session-session-beta'
    const legacy = JSON.stringify(raw)
    await writeFile(filePath(), legacy)

    const reopened = await open()
    expect(reopened.getSessionTabId('session-alpha')).toBe('tab-alpha')
    expect(reopened.getSessionTabId('session-beta')).toBe('structured-agent-session-session-beta')
    expect(reopened.getSessionTabId('session-gamma')).toBeNull()
    // Seeding is part of reading, so an open alone writes nothing.
    expect(await readFile(filePath(), 'utf-8')).toBe(legacy)

    await reopened.setSessionTabVisibility('session-gamma', true)
    const persisted = await readFileJson()
    expect(persisted.sessionTabs).toEqual([
      { tabId: 'tab-alpha', sessionId: 'session-alpha' },
      { tabId: 'structured-agent-session-session-beta', sessionId: 'session-beta' },
      { tabId: 'structured-agent-session-session-gamma', sessionId: 'session-gamma' }
    ])
    // Older builds restore from this list; the record field rides along untouched and unread.
    expect(persisted.visibleSessionIds).toEqual(['session-alpha', 'session-beta', 'session-gamma'])
    expect(persisted.records['session-alpha'].surfaceTabId).toBe('tab-alpha')
  })

  it('seeds a chat cleared before the upgrade under the id its tab opened with', async () => {
    const first = await open()
    for (const [index, sessionId] of ['session-alpha', 'clear-one', 'clear-two'].entries()) {
      await first.reserveOwner(
        reserveRequest({
          sessionId,
          operation: {
            callerKey: 'client-1',
            operationId: operationId(),
            fingerprint: `fp-chain-${index}`
          }
        })
      )
    }
    // An older build after two clears, with the first conversation reopened from history.
    const raw = await readFileJson()
    const cleared = (replacementSessionId: string) => ({
      command: 'clear',
      state: 'completed',
      phase: 'committed',
      operationId: operationId(),
      callerKey: 'client-1',
      replacementSessionId
    })
    raw.records['session-alpha'].conversationCommand = cleared('clear-one')
    raw.records['clear-one'].conversationCommand = cleared('clear-two')
    raw.records['clear-two'].surfaceTabId = 'structured-agent-session-clear-two'
    delete raw.sessionTabs
    raw.visibleSessionIds = ['session-alpha', 'clear-two']
    await writeFile(filePath(), JSON.stringify(raw))

    const reopened = await open()
    expect(reopened.getSessionTabId('clear-two')).toBe(LEGACY_TAB_ID)
    const reopenedTab = reopened.getSessionTabId('session-alpha')
    expect(reopenedTab).not.toBe(LEGACY_TAB_ID)
    expect(reopenedTab).not.toContain(':')
    expect(reopened.listVisibleSessionIds()).toEqual(['session-alpha', 'clear-two'])
    // Seeding is part of reading, so it must give the same ids on every read of the same bytes.
    expect((await open()).getSessionTabId('session-alpha')).toBe(reopenedTab)
  })

  it('reads the table, never the record field, once the table is on disk', async () => {
    const first = await open()
    await first.reserveOwner(reserveRequest())
    await first.setSessionTabVisibility('session-alpha', true, 'tab-alpha')
    const raw = await readFileJson()
    raw.records['session-alpha'].surfaceTabId = 'tab-stale'
    await writeFile(filePath(), JSON.stringify(raw))
    expect((await open()).getSessionTabId('session-alpha')).toBe('tab-alpha')
  })

  it('keeps a record whose legacy tab id is malformed, seeding it under the derived id', async () => {
    const first = await open()
    await first.reserveOwner(reserveRequest())
    const raw = await readFileJson()
    delete raw.sessionTabs
    raw.visibleSessionIds = ['session-alpha']
    raw.records['session-alpha'].surfaceTabId = 'agent-session:session-alpha'
    await writeFile(filePath(), JSON.stringify(raw))
    const reopened = await open()
    expect(reopened.isSessionUnreadable('session-alpha')).toBe(false)
    expect(reopened.getSessionTabId('session-alpha')).toBe(LEGACY_TAB_ID)
  })

  it('treats a malformed table as a corrupt store rather than guessing', async () => {
    const first = await open()
    await first.reserveOwner(reserveRequest())
    const raw = await readFileJson()
    raw.sessionTabs = [
      { tabId: 'tab-alpha', sessionId: 'session-alpha' },
      { tabId: 'tab-alpha', sessionId: 'session-beta' }
    ]
    await writeFile(filePath(), JSON.stringify(raw))
    await expect(open()).rejects.toThrow('agent_session_store_corrupt')
  })
})
