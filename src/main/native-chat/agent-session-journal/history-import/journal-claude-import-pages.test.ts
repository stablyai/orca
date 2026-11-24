import { serializedWorkerReplyBytes } from '../../../utility-worker-host/utility-worker-reply-size'
import { expect, it } from 'vitest'
import type { JournalReplacementItem } from '../context-epochs/journal-epoch-replacement'
import { claudeImportPages } from './journal-claude-import-pages'
import { collectClaudeImportWindow } from './journal-claude-import-window'

it('round-trips newest-first pages with wide tool input and split multibyte text', async () => {
  const item = (uuid: string, body: JournalReplacementItem['body']): JournalReplacementItem => ({
    identity: { provider: 'claude', sessionId: 'source', uuid },
    body,
    ownerFence: 0,
    turnScope: { kind: 'thread' }
  })
  const items = [
    item('first', { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'first' }] }),
    item('wide', {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          // The first emoji spans the first string-fragment boundary.
          text: 'x'.repeat(130_815) + '😀\r\n\ud800'.repeat(170_000)
        },
        {
          type: 'tool-call',
          callId: 'write',
          name: 'Write',
          input: {
            files: Array.from({ length: 700 }, (_, index) => ({
              name: `file-${index}`,
              content: '\\🌊\n'.repeat(450)
            })),
            flags: [true, null, 42]
          }
        }
      ]
    }),
    item('last', { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'last' }] })
  ]
  const pages = claudeImportPages(items)
  const window = await collectClaudeImportWindow(
    { sourceEmpty: false },
    async () => {
      const page = pages.next().value
      if (!page) {
        throw new Error('Import ended before a complete page.')
      }
      expect(serializedWorkerReplyBytes(page).framed).toBeLessThanOrEqual(512 * 1024)
      return page
    },
    () => {}
  )
  expect(window.items).toEqual(items)
})
