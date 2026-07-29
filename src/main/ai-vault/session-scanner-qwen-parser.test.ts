import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseQwenSessionFile } from './session-scanner-qwen-parser'
import type { FileWithMtime } from './session-scanner-types'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

const SESSION_ID = '6e2b0203-8900-4882-9490-be40ff87d010'
const CWD = '/private/tmp/qwen-test-proj'

// Mirrors real records produced by Qwen Code 0.21.0 under
// ~/.qwen/projects/<encoded-cwd>/chats/<sessionId>.jsonl.
function record(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    timestamp: '2026-07-29T14:22:00.410Z',
    cwd: CWD,
    version: '0.21.0',
    gitBranch: 'main',
    ...overrides
  }
}

const SESSION_LINES: Record<string, unknown>[] = [
  record({
    type: 'user',
    message: { role: 'user', parts: [{ text: 'What are your strengths vs Claude Code?' }] }
  }),
  record({
    type: 'system',
    subtype: 'attribution_snapshot',
    systemPayload: { snapshot: { type: 'attribution-snapshot', promptCount: 1 } }
  }),
  record({
    type: 'assistant',
    timestamp: '2026-07-29T14:22:11.480Z',
    model: 'qwen3.7-plus',
    message: {
      role: 'model',
      parts: [
        { text: 'Internal reasoning the user should not see.', thought: true },
        { text: 'Hello! I am Qwen Code.' }
      ]
    }
  })
]

async function writeQwenSession(
  lines: Record<string, unknown>[] | null
): Promise<{ file: FileWithMtime }> {
  const home = await mkdtemp(join(tmpdir(), 'orca-qwen-'))
  tempDirs.push(home)
  const chatsDir = join(home, 'projects', '-private-tmp-qwen-test-proj', 'chats')
  await mkdir(chatsDir, { recursive: true })
  const sessionPath = join(chatsDir, `${SESSION_ID}.jsonl`)
  const content = lines !== null ? lines.map((line) => JSON.stringify(line)).join('\n') : ''
  await writeFile(sessionPath, content)
  const mtimeMs = Date.now()
  return { file: { path: sessionPath, mtimeMs, modifiedAt: new Date(mtimeMs).toISOString() } }
}

describe('parseQwenSessionFile', () => {
  it('parses a full session from a chats transcript', async () => {
    const { file } = await writeQwenSession(SESSION_LINES)
    const session = await parseQwenSessionFile(file, 'darwin')

    expect(session).not.toBeNull()
    expect(session?.agent).toBe('qwen-code')
    expect(session?.sessionId).toBe(SESSION_ID)
    expect(session?.title).toBe('What are your strengths vs Claude Code?')
    expect(session?.cwd).toBe(CWD)
    expect(session?.branch).toBe('main')
    expect(session?.model).toBe('qwen3.7-plus')
    // 1 user turn + 1 assistant turn; system records are ignored.
    expect(session?.messageCount).toBe(2)
    expect(session?.createdAt).toBe('2026-07-29T14:22:00.410Z')
    expect(session?.updatedAt).toBe('2026-07-29T14:22:11.480Z')
  })

  it('excludes thought parts from the assistant preview', async () => {
    const { file } = await writeQwenSession(SESSION_LINES)
    const session = await parseQwenSessionFile(file, 'darwin')
    expect(session?.previewMessages).toEqual([
      {
        role: 'user',
        text: 'What are your strengths vs Claude Code?',
        timestamp: '2026-07-29T14:22:00.410Z'
      },
      { role: 'assistant', text: 'Hello! I am Qwen Code.', timestamp: '2026-07-29T14:22:11.480Z' }
    ])
  })

  it('builds a cwd-scoped resume command', async () => {
    const { file } = await writeQwenSession(SESSION_LINES)
    const session = await parseQwenSessionFile(file, 'darwin')
    expect(session?.resumeCommand).toBe(`cd '${CWD}' && qwen --resume '${SESSION_ID}'`)
  })

  it('strips injected system-reminder blocks from the title', async () => {
    const { file } = await writeQwenSession([
      record({
        type: 'user',
        message: {
          role: 'user',
          parts: [
            { text: '<system-reminder>\nAuto permission mode is active.\n</system-reminder>' }
          ]
        }
      }),
      record({
        type: 'user',
        timestamp: '2026-07-29T14:23:00.000Z',
        message: { role: 'user', parts: [{ text: 'Real follow-up prompt' }] }
      })
    ])
    const session = await parseQwenSessionFile(file, 'darwin')
    expect(session?.title).toBe('Real follow-up prompt')
  })

  it('still lists a metadata-only session for an empty transcript', async () => {
    const { file } = await writeQwenSession(null)
    const session = await parseQwenSessionFile(file, 'darwin')
    expect(session?.sessionId).toBe(SESSION_ID)
    expect(session?.messageCount).toBe(0)
    expect(session?.model).toBeNull()
    expect(session?.cwd).toBeNull()
  })

  it('keeps previews at the 220-char limit', async () => {
    const { file } = await writeQwenSession([
      record({ type: 'user', message: { role: 'user', parts: [{ text: 'y'.repeat(300) }] } })
    ])
    const session = await parseQwenSessionFile(file, 'darwin')
    const [userPreview] = session!.previewMessages
    expect(userPreview.text.length).toBe(220)
    expect(userPreview.text.endsWith('...')).toBe(true)
  })
})
