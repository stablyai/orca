import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseJcodeSessionContent, parseJcodeSessionFile } from './session-scanner-jcode-parser'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

describe('parseJcodeSessionFile', () => {
  it('parses a jcode session doc, skipping injected context envelopes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-jcode-parser-'))
    tempDirs.push(dir)
    const path = join(dir, 'session_badger_123.json')
    const mtimeMs = Date.now()
    await writeFile(
      path,
      JSON.stringify({
        id: 'session_badger_123',
        short_name: 'badger',
        model: 'deepseek-v4-flash',
        working_dir: '/repo',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:01:00Z',
        messages: [
          {
            id: 'm1',
            role: 'user',
            display_role: 'system',
            content: [{ type: 'text', text: '<system-reminder>injected</system-reminder>' }]
          },
          {
            id: 'm2',
            role: 'user',
            content: [{ type: 'text', text: 'fix the bug' }]
          },
          { id: 'm3', role: 'assistant', content: [{ type: 'text', text: 'done' }] }
        ]
      })
    )

    const session = await parseJcodeSessionFile({
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    })

    expect(session).not.toBeNull()
    expect(session?.agent).toBe('jcode')
    expect(session?.sessionId).toBe('session_badger_123')
    expect(session?.model).toBe('deepseek-v4-flash')
    expect(session?.cwd).toBe('/repo')
    expect(session?.messageCount).toBe(2)
    expect(session?.title).toBe('fix the bug')
    expect(session?.previewMessages).toEqual([
      { role: 'user', text: 'fix the bug', timestamp: null },
      { role: 'assistant', text: 'done', timestamp: null }
    ])
    expect(session?.resumeCommand).toContain("jcode --resume 'session_badger_123'")
  })

  it('skips a malformed (partially written) session doc', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-jcode-parser-'))
    tempDirs.push(dir)
    const path = join(dir, 'session_badger_456.json')
    const mtimeMs = Date.now()
    await writeFile(path, '{"id": "session_badger_456", "messages": [{"role": "user",')

    const session = await parseJcodeSessionFile({
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    })
    expect(session).toBeNull()
  })

  it('falls back to the file name for the session id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orca-jcode-parser-'))
    tempDirs.push(dir)
    const path = join(dir, 'session_orphan_9.json')
    const mtimeMs = Date.now()
    await writeFile(path, JSON.stringify({ messages: [] }))
    const session = await parseJcodeSessionFile({
      path,
      mtimeMs,
      modifiedAt: new Date(mtimeMs).toISOString()
    })
    expect(session?.sessionId).toBe('session_orphan_9')
    expect(session?.messageCount).toBe(0)
  })
})

it('keeps the session\u2019s stored name, counts tokens, and skips internal turns', () => {
  const session = parseJcodeSessionContent(
    {
      path: '/home/u/.jcode/sessions/session_x.json',
      mtimeMs: 1,
      modifiedAt: '2026-05-01T10:12:00.000Z'
    },
    JSON.stringify({
      id: 'session_x',
      title: 'Release prep',
      model: 'claude-haiku-4-5',
      messages: [
        // display_role background_task is StoredDisplayRole::BackgroundTask.
        { id: 'm0', role: 'user', display_role: 'background_task', content: 'internal' },
        { id: 'm1', role: 'user', content: '[Scheduled task] nightly sweep' },
        {
          id: 'm2',
          role: 'user',
          content: 'Fix the greet helper',
          token_usage: { input_tokens: 10, output_tokens: 4 }
        },
        {
          id: 'm3',
          role: 'assistant',
          content: 'Done.',
          token_usage: { input_tokens: 2, output_tokens: 6 }
        }
      ]
    }),
    'linux'
  )
  expect(session?.title).toBe('Release prep')
  expect(session?.messageCount).toBe(2)
  expect(session?.totalTokens).toBe(22)
})
