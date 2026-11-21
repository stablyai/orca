import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { TranscriptMessage } from '../../transcripts/session-transcript-consumers'
import { parseGrokSessionFile } from './session-scanner-grok-parser'

async function parseGrokHistory(rows: Record<string, unknown>[]) {
  const dir = await mkdtemp(join(tmpdir(), 'orca-grok-history-'))
  try {
    const path = join(dir, 'summary.json')
    await writeFile(path, JSON.stringify({ info: { id: 'session-1' } }))
    await writeFile(
      join(dir, 'chat_history.jsonl'),
      rows.map((row) => JSON.stringify(row)).join('\n')
    )
    const messages: TranscriptMessage[] = []
    const session = await parseGrokSessionFile(
      { path, mtimeMs: 0, modifiedAt: '1970-01-01T00:00:00.000Z' },
      'darwin',
      { active: true, push: (message) => messages.push(message) }
    )
    return { session, messages: messages.map(({ role, text }) => [role, text]) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

it('excludes runtime-injected user rows from search but keeps text the user wrote', async () => {
  const { session, messages } = await parseGrokHistory([
    {
      type: 'user',
      synthetic_reason: 'system_reminder',
      content: [{ type: 'text', text: '<system-reminder>Internal note</system-reminder>' }]
    },
    {
      type: 'user',
      content: [{ type: 'text', text: '<user_query>Find the invoice</user_query>' }]
    },
    { type: 'assistant', content: 'The invoice is ready.' },
    {
      type: 'user',
      synthetic_reason: 'interjection',
      content: '<note>\n<user_query>\nUse the March total\n</user_query>\n<reminder>'
    },
    { type: 'user', synthetic_reason: ' ', content: 'Show the total' }
  ])
  expect(messages).toEqual([
    ['user', 'Find the invoice'],
    ['assistant', 'The invoice is ready.'],
    ['user', 'Use the March total'],
    ['user', 'Show the total']
  ])
  expect(session?.title).toBe('Find the invoice')
})

it.each(['agent_message', 'parent_agent_message'])(
  'keeps a message relayed from a parent session searchable (%s)',
  async (syntheticReason) => {
    const { session, messages } = await parseGrokHistory([
      { type: 'user', synthetic_reason: syntheticReason, content: 'Review the billing module' }
    ])
    expect(messages).toEqual([['user', 'Review the billing module']])
    expect(session?.title).toBe('Review the billing module')
  }
)
