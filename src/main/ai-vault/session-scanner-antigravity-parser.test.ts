import { describe, expect, it } from 'vitest'
import { parseAntigravitySessionContent } from './session-scanner-antigravity-parser'
import type { FileWithMtime } from './session-scanner-types'
import { jsonLines } from './session-scanner-test-fixtures'

const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

describe('Antigravity AI Vault parser', () => {
  it('parses the established transcript contract without leaking metadata wrappers', async () => {
    const session = await parseAntigravitySessionContent(
      file(
        `/home/ada/.gemini/antigravity-cli/brain/${SESSION_ID}/.system_generated/logs/transcript.jsonl`
      ),
      jsonLines([
        {
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: '2026-07-15T11:39:10Z',
          content:
            '<USER_REQUEST>\nFix the vault adapter\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>'
        },
        {
          step_index: 1,
          source: 'SYSTEM',
          type: 'CONVERSATION_HISTORY',
          created_at: '2026-07-15T11:39:11Z'
        },
        {
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: '2026-07-15T11:39:12Z',
          content: 'The adapter is ready.'
        },
        {
          step_index: 3,
          source: 'SYSTEM',
          type: 'CHECKPOINT',
          created_at: '2026-07-15T11:39:14Z',
          content: 'internal checkpoint'
        }
      ]),
      'linux'
    )

    expect(session).toMatchObject({
      agent: 'antigravity',
      sessionId: SESSION_ID,
      title: 'Fix the vault adapter',
      cwd: null,
      model: null,
      createdAt: '2026-07-15T11:39:10.000Z',
      updatedAt: '2026-07-15T11:39:14.000Z',
      messageCount: 2,
      resumeCommand: `agy --conversation '${SESSION_ID}'`
    })
    expect(session?.previewMessages).toEqual([
      {
        role: 'user',
        text: 'Fix the vault adapter',
        timestamp: '2026-07-15T11:39:10.000Z'
      },
      {
        role: 'assistant',
        text: 'The adapter is ready.',
        timestamp: '2026-07-15T11:39:12.000Z'
      }
    ])
  })

  it('derives the conversation id from Windows paths and quotes the resume command', async () => {
    const session = await parseAntigravitySessionContent(
      file(
        `C:\\Users\\Ada\\.gemini\\antigravity-cli\\brain\\${SESSION_ID}\\.system_generated\\logs\\transcript.jsonl`
      ),
      jsonLines([
        {
          source: 'USER',
          type: 'REQUEST',
          created_at: '2026-07-15T11:39:10Z',
          content: 'Windows prompt'
        }
      ]),
      'win32'
    )

    expect(session).toMatchObject({
      sessionId: SESSION_ID,
      title: 'Windows prompt',
      resumeCommand: `agy --conversation "${SESSION_ID}"`
    })
  })

  it('rejects files outside the targeted Antigravity transcript layout', async () => {
    await expect(
      parseAntigravitySessionContent(
        file('/home/ada/.gemini/antigravity-cli/brain/transcript.jsonl'),
        jsonLines([{ source: 'USER', type: 'REQUEST', content: 'Not a conversation transcript' }])
      )
    ).resolves.toBeNull()
  })
})

function file(path: string): FileWithMtime {
  return {
    path,
    mtimeMs: Date.parse('2026-07-15T11:39:14Z'),
    modifiedAt: '2026-07-15T11:39:14.000Z',
    sizeBytes: 1
  }
}
