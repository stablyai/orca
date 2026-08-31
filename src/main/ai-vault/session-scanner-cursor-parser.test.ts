import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cursorWorkspaceSlug } from '../../shared/cursor-workspace-slug'
import { folderLabel, groupAiVaultSessions } from '../../shared/ai-vault-session-filters'
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
  it('sets cwd from a matching workspace trust marker', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-cursor-parse-'))
    tempDirs.push(root)
    const workspace = join(root, 'orcacwdparseopc')
    mkdirSync(workspace, { recursive: true })
    const slug = cursorWorkspaceSlug(workspace)
    const transcripts = join(root, '.cursor', 'projects', slug, 'agent-transcripts')
    mkdirSync(transcripts, { recursive: true })
    writeFileSync(
      join(root, '.cursor', 'projects', slug, '.workspace-trusted'),
      JSON.stringify({ workspacePath: workspace })
    )
    const filePath = join(transcripts, 'cursor-session.jsonl')
    writeFileSync(filePath, jsonl)

    const session = await parseCursorSessionFile({ path: filePath, mtimeMs: 1, modifiedAt: '' })
    expect(session?.cwd).toBe(workspace)
    expect(session?.sessionId).toBe('cursor-session')
    expect(
      groupAiVaultSessions(session ? [session] : [], 'folder').map((group) => group.label)
    ).toEqual([folderLabel(workspace)])
  })
})

describe('parseCursorSessionContent cwd attribution', () => {
  it('does not invent a remote cwd from a lossy slug or the local filesystem', async () => {
    const session = await parseCursorSessionContent(
      {
        path: 'C:\\Users\\u\\.cursor\\projects\\c-Dev-simulations-opc\\agent-transcripts\\83e98eef-916b-4d99-95bf-bc66fab9741e.jsonl',
        mtimeMs: 1,
        modifiedAt: ''
      },
      jsonl,
      'win32'
    )
    expect(session?.cwd).toBeNull()
    expect(session?.sessionId).toBe('83e98eef-916b-4d99-95bf-bc66fab9741e')
  })
})
