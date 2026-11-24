import { serialize } from 'node:v8'
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
  const pages = claudeImportPages({ items, savedKeys: [['first-key'], ['wide-key'], ['last-key']] })
  const keys: string[][] = []
  let pageCount = 0
  const window = await collectClaudeImportWindow(
    { sourceEmpty: false, forkTipItemIds: [], sourceConsumedBytes: 0, sourceSkippedRecords: 0 },
    async () => {
      const page = pages.next().value
      if (!page) {
        throw new Error('Import ended before a complete page.')
      }
      const bytes = serialize({ type: 'message', bytes: serialize(page), more: false }).byteLength
      expect(bytes).toBeLessThanOrEqual(512 * 1024)
      pageCount++
      return page
    },
    () => {},
    new AbortController().signal,
    {
      budget: () => 16 * 1024 * 1024,
      page: async (completed) => {
        keys.push(...completed.map((entry) => entry.keys))
      }
    }
  )
  expect(pageCount).toBeGreaterThan(1)
  expect(window.items).toEqual(items)
  expect(keys).toEqual([['last-key'], ['wide-key'], ['first-key']])
})
