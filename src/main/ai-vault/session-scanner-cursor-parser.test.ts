import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseCursorSessionFile } from './session-scanner-cursor-parser'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

describe('parseCursorSessionFile cwd attribution', () => {
  it('sets cwd from the Cursor project slug when JSONL has no cwd field', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-cursor-parse-'))
    tempDirs.push(root)
    const projectDir = join(root, 'projects', 'Users-ada-code-orca')
    const transcripts = join(projectDir, 'agent-transcripts')
    mkdirSync(transcripts, { recursive: true })
    const filePath = join(transcripts, 'cursor-session.jsonl')
    writeFileSync(
      filePath,
      [
        JSON.stringify({
          role: 'user',
          message: { content: [{ type: 'text', text: 'Hello' }] },
          timestamp: '2026-08-12T00:00:00.000Z'
        }),
        JSON.stringify({
          role: 'assistant',
          message: { content: [{ type: 'text', text: 'Hi' }] },
          timestamp: '2026-08-12T00:00:01.000Z'
        })
      ].join('\n')
    )

    const session = await parseCursorSessionFile({ path: filePath, mtimeMs: 1, modifiedAt: '' })
    expect(session?.cwd).toBe('/Users/ada/code/orca')
    expect(session?.sessionId).toBe('cursor-session')
  })
})
