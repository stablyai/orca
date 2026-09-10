import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import { forkJournalIdentity, forkJournalSeed } from './structured-fork-journal-seed'

const body: AgentJournalItemBody = {
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text: 'Retained answer' }]
}
const source = { provider: 'codex', threadId: 'parent' } as const
const target = { provider: 'codex', threadId: 'child' } as const

describe('fork journal identities', () => {
  it('rekeys every Codex item to the new thread while retaining turns and ordinals', () => {
    const items = ['turn-a', 'turn-b'].flatMap((turnId) =>
      [0, 1, 2].map((ordinal) => ({
        itemId: agentJournalItemKey({ provider: 'codex', threadId: 'parent', turnId, ordinal }),
        body,
        observedAt: 123
      }))
    )
    const seed = forkJournalSeed(items, source, target)
    expect(seed.map((item) => agentJournalItemKey(item.identity))).toEqual([
      'codex:child:turn-a:0',
      'codex:child:turn-a:1',
      'codex:child:turn-a:2',
      'codex:child:turn-b:0',
      'codex:child:turn-b:1',
      'codex:child:turn-b:2'
    ])
    expect(items.every((item) => item.itemId.startsWith('codex:parent:'))).toBe(true)
    const hydration = new Map(seed.map((item) => [agentJournalItemKey(item.identity), item.body]))
    hydration.set(
      agentJournalItemKey({ provider: 'codex', threadId: 'child', turnId: 'turn-a', ordinal: 1 }),
      body
    )
    expect(hydration.size).toBe(6)
  })

  it('preserves Claude transcript session ids and UUIDs, including inherited ancestry', () => {
    const items = ['ancestor', 'parent'].map((sessionId) => ({
      itemId: agentJournalItemKey({ provider: 'claude', sessionId, uuid: 'same-uuid' }),
      body,
      observedAt: 123
    }))
    const seed = forkJournalSeed(
      items,
      { provider: 'claude', sessionId: 'parent', leafUuid: 'same-uuid' },
      { provider: 'claude', sessionId: 'child', leafUuid: 'same-uuid' }
    )
    expect(seed.map((item) => agentJournalItemKey(item.identity))).toEqual(
      items.map((item) => item.itemId)
    )
  })

  it('keys a rewritten Claude transcript prefix by the parent session and original UUID', () => {
    const transcript = [
      { sessionId: 'child', uuid: 'prompt' },
      { sessionId: 'child', uuid: 'answer' }
    ]
    const seed = forkJournalSeed(
      transcript.map((row) => ({
        itemId: agentJournalItemKey({ provider: 'claude', ...row }),
        body,
        observedAt: 123
      })),
      { provider: 'claude', sessionId: 'parent', leafUuid: 'answer' },
      { provider: 'claude', sessionId: 'child', leafUuid: 'answer' }
    )
    expect(seed.map((item) => agentJournalItemKey(item.identity))).toEqual([
      'claude:parent:prompt',
      'claude:parent:answer'
    ])
  })

  it('refuses foreign provider and thread identities instead of collapsing namespaces', () => {
    expect(() =>
      forkJournalIdentity(
        { provider: 'codex', threadId: 'foreign', turnId: 'turn', ordinal: 0 },
        source,
        target
      )
    ).toThrow('agent_session_identity_required')
    expect(() =>
      forkJournalIdentity({ provider: 'claude', sessionId: 'parent', uuid: 'id' }, source, target)
    ).toThrow('agent_session_identity_required')
  })

  it('carries an adopted transcript into the child and continues it on the new thread', () => {
    // Adoption imports the whole prior conversation under `legacy:` keys, so a turn taken after
    // adopting is a mix of legacy history and Codex echoes. Both belong in the child.
    const imported = ['msg_1', 'msg_2'].map((recordId) => ({
      itemId: agentJournalItemKey({
        provider: 'legacy',
        agent: 'codex',
        sessionId: 'parent',
        recordId
      }),
      body,
      observedAt: 1
    }))
    const seed = forkJournalSeed(
      [
        ...imported,
        { itemId: 'codex:parent:turn-a:0', body, observedAt: 2 },
        { itemId: 'codex:parent:turn-a:1', body, observedAt: 3 }
      ],
      source,
      target
    )
    expect(seed.map((item) => agentJournalItemKey(item.identity))).toEqual([
      'legacy:codex:parent:msg_1',
      'legacy:codex:parent:msg_2',
      'codex:child:turn-a:0',
      'codex:child:turn-a:1'
    ])
  })

  it('leaves the parent turn-lifecycle row behind rather than seeding a phantom running turn', () => {
    const lifecycle: AgentJournalItemBody = {
      kind: 'status',
      text: 'Codex is working…',
      turnLifecycle: { turnId: 'turn-a', state: 'running' }
    }
    const seed = forkJournalSeed(
      [
        {
          itemId: agentJournalItemKey({
            provider: 'legacy',
            agent: 'codex',
            sessionId: 'parent',
            recordId: 'turn-lifecycle:turn-a'
          }),
          body: lifecycle,
          observedAt: 1
        },
        { itemId: 'codex:parent:turn-a:1', body, observedAt: 2 }
      ],
      source,
      target
    )
    expect(seed.map((item) => agentJournalItemKey(item.identity))).toEqual(['codex:child:turn-a:1'])
  })

  it('does not retain source submission identities or prompt authority', () => {
    const prompt: AgentJournalItemBody = {
      kind: 'approval',
      title: 'Allow tool',
      detail: null,
      options: [],
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: 'parent-client',
        resolvedAt: null
      }
    }
    const seed = forkJournalSeed(
      [
        { itemId: 'orca:submission', body, observedAt: 1 },
        { itemId: 'codex:parent:turn:0', body: prompt, observedAt: 2 }
      ],
      source,
      target
    )
    expect(seed).toHaveLength(1)
    expect(seed[0]?.body).toMatchObject({ resolution: { state: 'cancelled', resolvedBy: null } })
    expect(prompt.resolution.state).toBe('pending')
  })
})
