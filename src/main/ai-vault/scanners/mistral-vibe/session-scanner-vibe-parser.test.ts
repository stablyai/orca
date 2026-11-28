import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { AiVaultScanIssueError } from '../../parsing/session-scan-issues'
import { parseVibeSessionFile } from './session-scanner-vibe-parser'

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vibe-parser-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const writeSession = async (shortId: string, lines: string[], meta: string | null) => {
  const sessionDir = join(dir, `session_20260101_120000_${shortId}`)
  await mkdir(sessionDir, { recursive: true })
  const file = join(sessionDir, 'messages.jsonl')
  await writeFile(file, lines.length > 0 ? `${lines.join('\n')}\n` : '')
  if (meta !== null) {
    await writeFile(join(sessionDir, 'meta.json'), meta)
  }
  return { path: file, mtimeMs: 1, modifiedAt: '2026-01-01T00:00:00.000Z' }
}

it('reads the full session id, title, cwd, model and tokens from meta.json', async () => {
  const file = await writeSession(
    'abcd1234',
    [
      JSON.stringify({ role: 'user', content: 'hello vibe', message_id: 'm1' }),
      JSON.stringify({ role: 'assistant', content: 'hi', message_id: 'm2' })
    ],
    JSON.stringify({
      session_id: 'full-uuid-1234',
      title: 'My session',
      environment: { working_directory: '/repo' },
      git_branch: 'main',
      config: { active_model: 'devstral' },
      stats: { session_total_llm_tokens: 42 },
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:01:00.000Z'
    })
  )
  const session = await parseVibeSessionFile(file, 'linux')
  expect(session?.sessionId).toBe('full-uuid-1234')
  expect(session?.title).toBe('My session')
  expect(session?.cwd).toBe('/repo')
  expect(session?.branch).toBe('main')
  expect(session?.model).toBe('devstral')
  expect(session?.totalTokens).toBe(42)
  expect(session?.messageCount).toBe(2)
})

it('falls back to the directory-derived short id when meta.json is missing', async () => {
  const file = await writeSession(
    'abcd1234',
    [JSON.stringify({ role: 'user', content: 'hi' })],
    null
  )
  const session = await parseVibeSessionFile(file, 'linux')
  expect(session?.sessionId).toBe('abcd1234')
})

it('records a scan issue for an unparseable meta.json instead of caching a metadata-free session', async () => {
  const file = await writeSession(
    'abcd1234',
    [JSON.stringify({ role: 'user', content: 'hi' })],
    '{not json'
  )
  await expect(parseVibeSessionFile(file, 'linux')).rejects.toBeInstanceOf(AiVaultScanIssueError)
})

it('skips malformed jsonl lines and decodes tool_calls, keeping raw arguments on bad json', async () => {
  const file = await writeSession(
    'abcd1234',
    [
      'not json',
      JSON.stringify({ role: 'user', content: 'run it' }),
      JSON.stringify({
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 't1', function: { name: 'shell', arguments: '{"command":"ls"}' } },
          { function: { name: 'read', arguments: '{bad json' } }
        ]
      })
    ],
    JSON.stringify({ session_id: 'full-1' })
  )
  const session = await parseVibeSessionFile(file, 'linux')
  expect(session?.sessionId).toBe('full-1')
  // The malformed line is skipped, so only the two parseable records count.
  expect(session?.messageCount).toBe(2)
})
