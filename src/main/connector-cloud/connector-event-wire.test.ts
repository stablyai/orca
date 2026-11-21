import { expect, it } from 'vitest'
import type { ConversationEvent } from '../external-conversations/external-conversation-events'
import { toConnectorEvent } from './connector-event-wire'

// Phase 1 §4: a paused end says it resumes only to a cloud that shows the paused line.
it('tells a usage-limit pause resumes only to a cloud listing replies.paused', () => {
  const ended: ConversationEvent = {
    kind: 'turn-ended',
    conversation: { source: 'slack', externalId: 'slack:T1:C1:1.2' },
    worktreeId: 'w',
    paneKey: 'pane-1',
    turnId: 100,
    at: 200,
    stopReason: 'failure',
    stateOnly: true,
    resumes: true
  }
  expect(toConnectorEvent(ended, new Set(['replies.paused']))).toMatchObject({ resumes: true })
  expect(toConnectorEvent(ended, new Set())).not.toHaveProperty('resumes')
})
