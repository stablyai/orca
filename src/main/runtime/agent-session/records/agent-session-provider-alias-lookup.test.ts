import { describe, expect, it } from 'vitest'
import { claudeProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionStoreTransactions } from './agent-session-store-transactions'
import { scaleDirectory, scaleRecord } from './agent-session-scale.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { conversationRecordReader } from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import { lookupOrcaAgentSession } from '../../orchestration/mailbox/routing/structured-session-mail-address'

/** The native id the scale fixture gives each chat's provider handle. */
function aliasOf(sessionId: string): string {
  return `provider-${sessionId}-0`
}

async function storeWith(records: ReturnType<typeof scaleRecord>[]) {
  const root = await scaleDirectory()
  await seedTestAgentSessionRecordStore(root, { records })
  const store = await openTestAgentSessionRecordStore(root)
  return store
}

/** Commits through the store's own transaction, as every production write does. */
function commit(store: AgentSessionRecordStore, apply: (draft: AgentSessionStoreState) => void) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the store's private transaction owner; tests write through it to reach the real commit boundary.
  const { transactions } = store as unknown as { transactions: AgentSessionStoreTransactions }
  return transactions.transact(apply)
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

    await commit(store, (draft) =>
      draft.records.set('session-b', { ...draft.records.get('session-b')!, updatedAt: 99 })
    )
    expect(owner(aliasOf('session-a'))).toBe('session-a')

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

    // A replacement store answers from its own records.
    const replacement = conversationRecordReader(await storeWith([scaleRecord('session-d')]))
    expect(lookupOrcaAgentSession(replacement, aliasOf('session-c')).kind).toBe('unknown')
    expect(lookupOrcaAgentSession(replacement, aliasOf('session-d'))).toEqual({
      kind: 'provider-id',
      orcaSessionId: 'session-d'
    })
  })
})
