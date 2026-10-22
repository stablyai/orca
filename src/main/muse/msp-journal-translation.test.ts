import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { MspJournalTranslator, mspItemIdentity } from './msp-journal-translation'
import type { MspItem } from './msp-protocol'

function fakeSink() {
  const rows = new Map<string, AgentJournalItemBody>()
  const key = (identity: AgentJournalItemIdentity): string => agentJournalItemKey(identity)
  const sink = {
    tryAppendItem: (identity: AgentJournalItemIdentity, body: AgentJournalItemBody) => {
      rows.set(key(identity), body)
      return { accepted: true as const }
    },
    tryReviseResolvedItem: (
      _bytes: number,
      resolve: (journal: {
        itemBody: (itemKey: string) => AgentJournalItemBody | null
      }) => { identity: AgentJournalItemIdentity; body: AgentJournalItemBody } | null
    ) => {
      const out = resolve({ itemBody: (itemKey: string) => rows.get(itemKey) ?? null })
      if (out) {
        rows.set(key(out.identity), out.body)
      }
      return { accepted: true as const }
    },
    publish: () => undefined
  } as unknown as StructuredAgentSessionEventSink
  return { sink, rows }
}

const SESSION = 'sess-1'

function item(partial: Partial<MspItem> & { itemId: string; kind: MspItem['kind'] }): MspItem {
  return { turnId: 'turn-1', status: 'inProgress', revision: 1, ...partial }
}

describe('MspJournalTranslator', () => {
  it('journals a text turn end to end', () => {
    const { sink, rows } = fakeSink()
    const translator = new MspJournalTranslator({ sink, sessionId: SESSION })
    translator.writeUserMessage('client-1', [{ type: 'text', text: 'hi' }], 'turn-1')
    translator.openTurn('turn-1', { requestedAt: 1 })
    translator.itemStarted({
      sessionId: SESSION,
      item: item({ itemId: 'a1', kind: 'agentMessage', text: '' })
    })
    translator.itemDelta({ sessionId: SESSION, itemId: 'a1', field: 'text', delta: 'hel' })
    translator.itemDelta({ sessionId: SESSION, itemId: 'a1', field: 'text', delta: 'lo' })
    translator.itemCompleted({
      sessionId: SESSION,
      item: item({ itemId: 'a1', kind: 'agentMessage', status: 'completed', text: 'hello' })
    })
    translator.closeTurn({ sessionId: SESSION, turnId: 'turn-1' })
    const get = (itemId: string): AgentJournalItemBody | undefined =>
      rows.get(agentJournalItemKey(mspItemIdentity(SESSION, itemId)))
    expect(get('user:client-1')).toMatchObject({ kind: 'message', role: 'user' })
    expect(get('turn:turn-1')).toMatchObject({ kind: 'turn', state: 'completed' })
    const reply = get('a1')
    expect(reply).toMatchObject({ kind: 'message', role: 'assistant', state: 'completed' })
    if (reply?.kind === 'message') {
      expect(reply.blocks).toEqual([{ type: 'text', text: 'hello' }])
    }
  })

  it('journals tool calls through failure', () => {
    const { sink, rows } = fakeSink()
    const translator = new MspJournalTranslator({ sink, sessionId: SESSION })
    translator.openTurn('turn-2', {})
    translator.itemStarted({
      sessionId: SESSION,
      item: item({
        itemId: 't1',
        kind: 'toolCall',
        turnId: 'turn-2',
        name: 'read',
        args: '{"path":"x"}'
      })
    })
    translator.itemCompleted({
      sessionId: SESSION,
      item: item({
        itemId: 't1',
        kind: 'toolCall',
        turnId: 'turn-2',
        status: 'failed',
        failureReason: 'nope'
      })
    })
    const row = rows.get(agentJournalItemKey(mspItemIdentity(SESSION, 't1')))
    expect(row).toMatchObject({ kind: 'tool-call', name: 'read', state: 'failed' })
  })

  it('writes approvals and questions as pending rows and resolves them', () => {
    const { sink, rows } = fakeSink()
    const translator = new MspJournalTranslator({ sink, sessionId: SESSION })
    translator.writeApprovalRow('ap-1', 'item-ap', 'turn-3', {
      kind: 'approval',
      title: 'rm',
      detail: 'args',
      options: [{ id: 'yes', label: 'Yes' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
    expect(rows.get(agentJournalItemKey(mspItemIdentity(SESSION, 'item-ap')))).toMatchObject({
      kind: 'approval',
      resolution: { state: 'pending' }
    })
    translator.resolvePromptRow('item-ap', 'turn-3', { state: 'resolved', selectedOptionId: 'yes' })
    expect(rows.get(agentJournalItemKey(mspItemIdentity(SESSION, 'item-ap')))).toMatchObject({
      resolution: { state: 'resolved', selectedOptionId: 'yes' }
    })
  })

  it('mints stable identities', () => {
    expect(mspItemIdentity('s', 'i')).toEqual({ provider: 'muse', sessionId: 's', itemId: 'i' })
  })
})
