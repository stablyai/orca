import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorWorkspaceSlug } from '../../shared/cursor-workspace-slug'
import { parseCursorSessionContent, parseCursorSessionFile } from './session-scanner-cursor-parser'
import { resetCursorTrustedCwdCacheForTests } from './session-scanner-cursor-project-cwd'

const tempDirs: string[] = []

afterEach(() => {
  resetCursorTrustedCwdCacheForTests()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

const jsonl = [
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

describe('parseCursorSessionFile cwd attribution', () => {
  it('sets cwd from an existing workspace decoded from the Cursor project slug', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-cursor-parse-'))
    tempDirs.push(root)
    const workspace = join(tmpdir(), 'orcacwdparseopc')
    mkdirSync(workspace, { recursive: true })
    tempDirs.push(workspace)
    const transcripts = join(
      root,
      '.cursor',
      'projects',
      cursorWorkspaceSlug(workspace),
      'agent-transcripts'
    )
    mkdirSync(transcripts, { recursive: true })
    const filePath = join(transcripts, 'cursor-session.jsonl')
    writeFileSync(filePath, jsonl)

    const session = await parseCursorSessionFile({ path: filePath, mtimeMs: 1, modifiedAt: '' })
    expect(session?.cwd).toBe(workspace)
    expect(session?.sessionId).toBe('cursor-session')
  })
})

describe('parseCursorSessionContent cwd attribution', () => {
  it('does not invent a remote cwd from a lossy slug or the local filesystem', async () => {
    const session = await parseCursorSessionContent(
      {
        path: 'C:\\Users\\u\\.cursor\\projects\\c-Dev-simulations-opc\\agent-transcripts\\sid.jsonl',
        mtimeMs: 1,
        modifiedAt: ''
      },
      jsonl,
      'win32'
    )
    expect(session?.cwd).toBeNull()
    expect(session?.sessionId).toBe('sid')
  })
})
