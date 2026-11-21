import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { queuedMessageUpdateDecision } from './queued-message-update'
import type { QueuedMessageRow } from './queued-message-table'

const SESSION = 'session-1'
const agentPrompt: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'run the deploy' }],
  typedBy: { by: 'agent' }
}
const row = {
  messageId: 'q-1',
  position: 0,
  body: agentPrompt,
  fingerprint: agentSessionSendBodyFingerprint(SESSION, agentPrompt),
  state: 'waiting',
  holdReason: null,
  returnedReason: null,
  returnedRejection: null,
  consumedAs: null,
  queuedAt: null
} satisfies QueuedMessageRow

const edit = (typedBy?: AgentJournalMessageItem['typedBy']) =>
  queuedMessageUpdateDecision(row, SESSION, {
    messageId: 'q-1',
    expectedBodyFingerprint: row.fingerprint,
    text: 'run the deploy after review',
    ...(typedBy ? { typedBy } : {})
  })

describe('editing a queued message', () => {
  it('stamps the changed card with where the edit was typed, not where the card came from', () => {
    expect(edit({ by: 'host' })).toMatchObject({
      status: 'ready',
      body: { typedBy: { by: 'host' } }
    })
    const unknown = edit()
    expect(unknown.status).toBe('ready')
    expect(unknown).not.toHaveProperty('body.typedBy')
  })
})
