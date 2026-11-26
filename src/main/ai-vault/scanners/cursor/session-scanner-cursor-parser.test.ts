import { describe, expect, it } from 'vitest'
import { parseCursorSessionContent } from './session-scanner-cursor-parser'

const file = {
  path: '/home/test/.cursor/projects/project/agent-transcripts/chat/chat.jsonl',
  mtimeMs: 1,
  modifiedAt: new Date(1).toISOString()
}
const prompt = 'Fix the login bug'
const envelope = `<timestamp>Sunday, Oct 11, 2026, 4:30 PM (UTC+1)</timestamp>\n<user_query>\n${prompt}\n</user_query>`

function parseTitle(...records: object[]) {
  const lines = records.map((record) => JSON.stringify({ role: 'user', ...record })).join('\n')
  return parseCursorSessionContent(file, lines, 'linux').then((session) => session?.title)
}

describe('Cursor session titles', () => {
  it.each([
    ['message string', { message: { content: envelope } }],
    ['message text parts', { message: { content: [{ type: 'text', text: envelope }] } }],
    ['top-level content', { content: envelope }],
    [
      'long attached_files prefix',
      {
        message: {
          content: [
            {
              type: 'text',
              text: `<attached_files>\n<code_selection path="/repo/a.ts">\n${'L1: x\n'.repeat(40)}</code_selection>\n</attached_files>\n<user_query>\n${prompt}\n</user_query>`
            }
          ]
        }
      }
    ],
    ['plain prompt', { message: { content: prompt } }]
  ])('names the session after the ask: %s', async (_label, record) => {
    expect(await parseTitle(record)).toBe(prompt)
  })

  it('lets a later ask name the session when the first turn is bootstrap context only', async () => {
    expect(
      await parseTitle(
        { message: { content: '<user_info>OS: linux</user_info>' } },
        { message: { content: envelope } }
      )
    ).toBe(prompt)
  })
})
