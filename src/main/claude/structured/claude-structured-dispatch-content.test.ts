import { describe, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { claudeDispatchMessageContent } from './claude-structured-dispatch-content'

function userMessage(blocks: AgentJournalMessageItem['blocks']): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks }
}

const REMOTE_IMAGE = { type: 'image-ref' as const, url: 'https://example.test/a.png' }

describe('claudeDispatchMessageContent', () => {
  it('puts the text block last so a slash command still expands with an attachment', async () => {
    const content = await claudeDispatchMessageContent(
      userMessage([{ type: 'text', text: '/goal ship the parser' }, REMOTE_IMAGE])
    )

    expect(content).toEqual([
      { type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } },
      { type: 'text', text: '/goal ship the parser' }
    ])
  })
})
