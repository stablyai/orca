import { describe, expect, it } from 'vitest'
import {
  agentSessionProviderHandleKey,
  claudeProviderHandle
} from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { scaleDirectory, scaleRecord } from './agent-session-scale.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from './agent-session-record-store-test-harness'
import { conversationRecordReader } from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import { lookupOrcaAgentSession } from '../../orchestration/mailbox/routing/structured-session-mail-address'

async function storeWith(records: ReturnType<typeof scaleRecord>[]) {
  const root = await scaleDirectory()
  await seedTestAgentSessionRecordStore(root, { records })
  return openTestAgentSessionRecordStore(root)
}

describe('provider alias index at the SQL commit boundary', () => {
  it('publishes committed handle aliases and preserves duplicate ownership across unrelated writes', async () => {
    const store = await storeWith([
      scaleRecord('session-a'),
      {
        ...scaleRecord('session-b'),
        providerHandleChain: scaleRecord('session-b').providerHandleChain.map((link) => ({
          ...link,
          handle: claudeProviderHandle('provider-session-a-0', null)
        }))
      },
      scaleRecord('session-c')
    ])
    const reader = conversationRecordReader(store)
    const owner = (nativeId: string) => {
      const found = lookupOrcaAgentSession(reader, nativeId)
      return found.kind === 'provider-id' ? found.orcaSessionId : found.kind
    }
    expect(owner('provider-session-a-0')).toBe('session-a')
    await store.setConversationName('session-b', 'Renamed chat')
    expect(owner('provider-session-a-0')).toBe('session-a')

    const link = {
      linkId: 'continued-c',
      origin: 'forked' as const,
      forkedFromKey: agentSessionProviderHandleKey(
        claudeProviderHandle('provider-session-c-0', null)
      ),
      mintedAtFence: 7,
      observedAt: 3_000,
      handle: claudeProviderHandle('continued-c', null)
    }
    await store.updateRecord('session-c', {
      kind: 'provider-handle',
      args: { fence: 7, link, now: 3_000 }
    })
    expect(owner('continued-c')).toBe('session-c')
    expect(owner('provider-session-c-0')).toBe('session-c')
    expect(store.listRecords().map((record) => record.sessionId)).toEqual([
      'session-a',
      'session-b',
      'session-c'
    ])
    await expect(
      store.updateRecord('session-c', {
        kind: 'provider-handle',
        args: {
          fence: 6,
          link: { ...link, linkId: 'rejected', handle: claudeProviderHandle('rejected', null) },
          now: 4_000
        }
      })
    ).rejects.toThrow('agent_session_stale_fence')
    expect(owner('rejected')).toBe('unknown')
    expect(owner('continued-c')).toBe('session-c')

    const replacement = conversationRecordReader(await storeWith([scaleRecord('session-d')]))
    expect(lookupOrcaAgentSession(replacement, 'continued-c').kind).toBe('unknown')
    expect(lookupOrcaAgentSession(replacement, 'provider-session-d-0')).toEqual({
      kind: 'provider-id',
      orcaSessionId: 'session-d'
    })
  })
})
