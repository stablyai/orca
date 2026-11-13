import { beforeEach, describe, expect, it, vi } from 'vitest'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { countStoreWork, scaleDirectory, scaleRecord } from './agent-session-scale.test-fixture'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { conversationRecordReader } from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import { lookupOrcaAgentSession } from '../../orchestration/mailbox/routing/structured-session-mail-address'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

const hookServer = vi.hoisted(() => ({
  terminalAgentPlaces: vi.fn<(id: string) => Promise<{ paneKey: string }[] | null>>()
}))
vi.mock('../../../agent-hooks/server/agent-hook-server', () => ({ agentHookServer: hookServer }))

import { resolveTerminalAgentRecipient } from '../../rpc/methods/orchestration/messaging/session-recipient'

const TERMINAL = 'claude_0123456789abcdef'
const UNKNOWN = 'claude_fedcba9876543210'

function chatId(index: number): string {
  return `chat-${String(index).padStart(6, '0')}`
}

/** The native id the scale fixture gives each chat's provider handle. */
function aliasOf(sessionId: string): string {
  return `provider-${sessionId}-0`
}

async function storeWith(records: ReturnType<typeof scaleRecord>[], unreadable: string[] = []) {
  const root = await scaleDirectory()
  await seedTestAgentSessionRecordStore(root, { records })
  if (unreadable.length > 0) {
    // A bad lease leaves the row unreadable while its conversation still projects.
    await editPersistedTestAgentSessionStore(root, (state) => {
      for (const sessionId of unreadable) {
        Object.assign(state.records[sessionId]!.lease, { minimumNextFence: 'bad' })
      }
    })
  }
  const store = await openTestAgentSessionRecordStore(root)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recipient routing reads only the host's record store.
  setStructuredAgentSessionHost({ deps: { store } } as unknown as Parameters<
    typeof setStructuredAgentSessionHost
  >[0])
  return store
}

/** Commits through the store's own transaction, as every production write does. */
function commit(store: AgentSessionRecordStore, apply: (draft: AgentSessionStoreState) => void) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store's private transaction owner; tests write through it to reach the real commit boundary.
  const { transactions } = store as unknown as { transactions: AgentSessionStoreTransactions }
  return transactions.transact(apply)
}

function namingAlias(sessionId: string, nativeId: string) {
  const record = scaleRecord(sessionId)
  return {
    ...record,
    providerHandleChain: record.providerHandleChain.map((link) => ({
      ...link,
      handle: claudeProviderHandle(nativeId, null)
    }))
  }
}

const MAP_WALKS = ['keys', 'values', 'entries', Symbol.iterator] as const

/** Counts the entries visited by any walk of a map as large as the history. */
function countHistoryVisits(history: number): () => number {
  let visits = 0
  for (const walk of MAP_WALKS) {
    const original = Map.prototype[walk]
    vi.spyOn(Map.prototype, walk).mockImplementation(function (this: Map<unknown, unknown>) {
      const iterator = original.call(this)
      if (this.size < history) {
        return iterator
      }
      const counted = {
        next: () => {
          const step = iterator.next()
          visits += step.done ? 0 : 1
          return step
        },
        [Symbol.iterator]: () => counted
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a counting wrapper with the same next/iterator protocol as the map's own iterator.
      return counted as unknown as ReturnType<typeof original>
    })
  }
  return () => visits
}

function withAlias(store: AgentSessionRecordStore, sessionId: string, nativeId: string) {
  const record = store.getRecord(sessionId)!
  return {
    ...record,
    providerHandleChain: record.providerHandleChain.map((link) => ({
      ...link,
      handle: claudeProviderHandle(nativeId, null)
    }))
  }
}

describe.each([20_000, 200_000])('recipient lookup over %i chats', (chats) => {
  beforeEach(() => hookServer.terminalAgentPlaces.mockReset())

  it('answers chat, provider alias, terminal and unknown ids by key', async () => {
    const store = await storeWith(Array.from({ length: chats }, (_, i) => scaleRecord(chatId(i))))
    const reader = conversationRecordReader(store)
    const work = countStoreWork(store)
    // A hung identity worker: chat and alias answers never wait on it.
    hookServer.terminalAgentPlaces.mockReturnValue(new Promise(() => {}))
    const last = chatId(chats - 1)
    work.reset()
    expect(await resolveTerminalAgentRecipient(last)).toBeNull()
    // A chat id is answered by its own record: no alias index is built for it.
    expect(work.counts.views).toBe(1)
    expect(lookupOrcaAgentSession(reader, aliasOf(last))).toEqual({
      kind: 'provider-id',
      orcaSessionId: last
    })
    expect(await resolveTerminalAgentRecipient(aliasOf(chatId(0)))).toBeNull()
    expect(hookServer.terminalAgentPlaces).not.toHaveBeenCalled()

    hookServer.terminalAgentPlaces.mockImplementation(async (id) =>
      id === TERMINAL ? [{ paneKey: 'tab:pane' }] : null
    )
    work.reset()
    for (let request = 0; request < 100; request++) {
      expect(lookupOrcaAgentSession(reader, aliasOf(chatId(request))).kind).toBe('provider-id')
      expect(await resolveTerminalAgentRecipient(TERMINAL)).toEqual({
        sessionId: TERMINAL,
        places: [{ paneKey: 'tab:pane' }]
      })
      expect(await resolveTerminalAgentRecipient(UNKNOWN)).toBeNull()
    }
    // After the one index build, no request lists or projects the history.
    expect(work.counts.inventories).toBe(0)
    expect(work.counts.views).toBe(0)
    expect(work.counts.decodes).toBe(0)
  })

  it('picks a shared alias owner among its owners alone, readable before unreadable', async () => {
    const store = await storeWith(
      [
        namingAlias('early-unreadable-mixed', 'mixed-alias'),
        ...Array.from({ length: chats }, (_, i) => scaleRecord(chatId(i))),
        namingAlias('late-unreadable-1', 'shared-unreadable'),
        namingAlias('late-unreadable-2', 'shared-unreadable'),
        namingAlias('late-readable-1', 'shared-alias'),
        namingAlias('late-readable-2', 'shared-alias'),
        namingAlias('late-readable-mixed', 'mixed-alias')
      ],
      ['early-unreadable-mixed', 'late-unreadable-1', 'late-unreadable-2']
    )
    const reader = conversationRecordReader(store)
    const owner = (nativeId: string) => {
      const found = lookupOrcaAgentSession(reader, nativeId)
      return found.kind === 'provider-id' ? found.orcaSessionId : found.kind
    }
    // The first lookup builds the index; the requests after it are timed in visits.
    expect(owner('shared-alias')).toBe('late-readable-1')
    const visits = countHistoryVisits(chats)
    for (let request = 0; request < 100; request++) {
      expect(owner('shared-alias')).toBe('late-readable-1')
      expect(owner('shared-unreadable')).toBe('late-unreadable-1')
      expect(owner('mixed-alias')).toBe('late-readable-mixed')
    }
    expect(visits()).toBe(0)
  })
})

describe('provider alias index at the commit boundary', () => {
  it('follows committed handle changes and removals, and nothing else', async () => {
    const store = await storeWith([
      scaleRecord('session-a'),
      {
        ...scaleRecord('session-b'),
        providerHandleChain: scaleRecord('session-b').providerHandleChain.map((link) => ({
          ...link,
          handle: claudeProviderHandle(aliasOf('session-a'), null)
        }))
      },
      scaleRecord('session-c')
    ])
    const reader = conversationRecordReader(store)
    const owner = (nativeId: string) => {
      const found = lookupOrcaAgentSession(reader, nativeId)
      return found.kind === 'provider-id' ? found.orcaSessionId : found.kind
    }
    // Two chats name one alias: the first in listing order owns it.
    expect(owner(aliasOf('session-a'))).toBe('session-a')
    const work = countStoreWork(store)

    // An unrelated write to the later owner neither steals the alias nor rebuilds the index.
    await commit(store, (draft) =>
      draft.records.set('session-b', { ...draft.records.get('session-b')!, updatedAt: 99 })
    )
    expect(owner(aliasOf('session-a'))).toBe('session-a')
    expect(work.counts.views).toBe(1)

    // Deleted and set again in one draft, the first owner moves to the end, as its map does.
    await commit(store, (draft) => {
      const record = draft.records.get('session-a')!
      draft.records.delete('session-a')
      draft.records.set('session-a', { ...record, updatedAt: 98 })
    })
    expect(store.listRecords().map((record) => record.sessionId)).toEqual([
      'session-b',
      'session-c',
      'session-a'
    ])
    expect(owner(aliasOf('session-a'))).toBe('session-b')
    // Removing the winning duplicate passes the alias to the other owner.
    await commit(store, (draft) => draft.records.delete('session-b'))
    expect(owner(aliasOf('session-a'))).toBe('session-a')
    // A handle change moves the record's aliases.
    await commit(store, (draft) =>
      draft.records.set('session-a', withAlias(store, 'session-a', 'renamed-a'))
    )
    expect(owner(aliasOf('session-a'))).toBe('unknown')
    expect(owner('renamed-a')).toBe('session-a')
    // A failed transaction changes nothing.
    await expect(
      commit(store, (draft) => {
        draft.records.set('session-c', withAlias(store, 'session-c', 'rolled-back'))
        throw new Error('rejected')
      })
    ).rejects.toThrow('rejected')
    expect(owner('rolled-back')).toBe('unknown')
    expect(owner(aliasOf('session-c'))).toBe('session-c')
    expect(work.counts.inventories).toBe(0)

    // A replacement store answers from its own records.
    const replacement = conversationRecordReader(await storeWith([scaleRecord('session-d')]))
    expect(lookupOrcaAgentSession(replacement, aliasOf('session-c')).kind).toBe('unknown')
    expect(lookupOrcaAgentSession(replacement, aliasOf('session-d'))).toEqual({
      kind: 'provider-id',
      orcaSessionId: 'session-d'
    })
  })
})
