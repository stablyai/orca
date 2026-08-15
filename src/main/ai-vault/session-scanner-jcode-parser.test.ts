import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseJcodeSessionFile } from './session-scanner-jcode-parser'

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
