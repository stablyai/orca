import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalStatusItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { CodexTurnFailures } from './codex-turn-failures'

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

it('journals Codex throttles as provider unavailability and quota errors as usage limits', () => {
  const rows: AgentJournalStatusItem[] = []
  const failures = new CodexTurnFailures({
    activeTurn: () => null,
    append: (_threadId, _payload, frame) => {
      rows.push(frame.body)
      return CODEX_JOURNAL_ADMITTED
    }
  })
  failures.observe('notification:account/rateLimits/updated', {
    rateLimits: {
      limitId: 'codex',
      secondary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: null }
    }
  })

  const errors = [
    {
      message: 'exceeded retry limit, last status: 429 Too Many Requests',
      codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } }
    },
    { message: 'Slow down', codexErrorInfo: 'rateLimitExceeded' },
    { message: 'You’ve hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' }
  ]
  const threadId = 'thread'
  for (const [index, error] of errors.entries()) {
    const payload = {
      threadId,
      turnId: `turn-${index}`,
      willRetry: false,
      error: { ...error, additionalDetails: null }
    }
    failures.appendTerminal('notification:error', payload, payload, threadId)
  }

  expect(rows.map((row) => row.failure?.kind)).toEqual([
    'providerUnavailable',
    'providerUnavailable',
    'usageLimitReached'
  ])
})
