import { expect, it } from 'vitest'
import { codexJournalItem } from './codex-structured-item-translation'

it('restores a voice hand-off as the readable request, not as its wrapper', () => {
  const restored = codexJournalItem({
    type: 'userMessage',
    id: 'u1',
    content: [
      {
        type: 'text',
        text: '<realtime_delegation>\n  <input>Open the &lt;README&gt; &amp; summarize it</input>\n  <transcript_delta>user: Open the README</transcript_delta>\n</realtime_delegation>',
        text_elements: []
      }
    ]
  })
  expect(restored.body).toEqual({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'Open the <README> & summarize it' }]
  })
})
