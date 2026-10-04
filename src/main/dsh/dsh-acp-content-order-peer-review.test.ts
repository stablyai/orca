import { expect, it } from 'vitest'
import { DshAcpJournal } from './dsh-acp-journal'

it('accepts the pinned upstream text/JPEG/text assistant output sequence', () => {
  const journal = new DshAcpJournal(() => 'official-content-order')
  journal.begin('text-image-text')
  journal.update(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'before' }
    },
    false
  )
  expect(() =>
    journal.update(
      {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'image', data: 'Ag==', mimeType: 'image/jpeg' }
      },
      false
    )
  ).not.toThrow()
  journal.update(
    {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'after' }
    },
    false
  )
})
