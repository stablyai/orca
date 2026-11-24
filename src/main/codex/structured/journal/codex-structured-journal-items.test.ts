import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

it('keeps a reply whose item id a provider reuses in a later turn as its own row', () => {
  const rows = new Map<string, unknown>()
  const translator = createCodexJournalTranslator({
    sink: {
      appendItem: (identity, body) => rows.set(agentJournalItemKey(identity), body),
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const send = (method: string, params: Record<string, unknown>): void => {
    translator.handle({ type: 'notification', sessionId: 's', threadId: 't', method, params })
  }
  for (const [turnId, text] of [
    ['turn-a', 'first answer'],
    ['turn-b', 'second answer']
  ]) {
    const item = { type: 'agentMessage', id: 'msg_0', text: '' }
    const user = { type: 'userMessage', id: `user-${turnId}`, content: [] }
    send('turn/started', { threadId: 't', turn: { id: turnId } })
    send('item/completed', { threadId: 't', turnId, item: user })
    send('item/started', { threadId: 't', turnId, item })
    send('item/agentMessage/delta', { threadId: 't', turnId, itemId: 'msg_0', delta: text })
    send('item/completed', { threadId: 't', turnId, item: { ...item, text } })
    send('turn/completed', { threadId: 't', turn: { id: turnId, status: 'completed' } })
  }
  translator.flush()

  const bodyJson = (key: string): string | undefined => JSON.stringify(rows.get(key))
  // Ordinal 1 follows the user echo, matching how history import numbers each turn.
  expect([...rows.keys()]).toEqual(['codex:t:turn-a:1', 'codex:t:turn-b:1'])
  expect(bodyJson('codex:t:turn-a:1')).toContain('first answer')
  expect(bodyJson('codex:t:turn-b:1')).toContain('second answer')
})
