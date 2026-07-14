import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { claudeProjectSlug, writeWebChatAsClaudeSession } from './web-chat-to-claude-session'

const msg = (role: NativeChatMessage['role'], text: string, i: number): NativeChatMessage => ({
  id: `m${i}`,
  role,
  blocks: [{ type: 'text', text }],
  timestamp: i,
  source: 'transcript'
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-proj-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('claudeProjectSlug: / 와 . 를 - 로', () => {
  expect(claudeProjectSlug('/Users/x/a.b/c')).toBe('-Users-x-a-b-c')
})

test('writeWebChatAsClaudeSession: parentUuid 체인 + sessionId==파일명 + 필드셋', () => {
  const res = writeWebChatAsClaudeSession({
    messages: [msg('user', '2+2?', 0), msg('assistant', '4', 1)],
    cwd: '/tmp/wt',
    gitBranch: 'main',
    dirOverride: dir
  })
  expect('sessionId' in res).toBe(true)
  if (!('sessionId' in res)) {
    throw new Error('expected sessionId')
  }
  const files = readdirSync(dir)
  expect(files).toEqual([`${res.sessionId}.jsonl`])
  const lines = readFileSync(join(dir, files[0]), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(lines).toHaveLength(2)
  expect(lines[0]).toMatchObject({
    parentUuid: null,
    type: 'user',
    sessionId: res.sessionId,
    cwd: '/tmp/wt',
    gitBranch: 'main',
    userType: 'external',
    isSidechain: false,
    message: { role: 'user', content: '2+2?' }
  })
  expect(lines[1]).toMatchObject({
    parentUuid: lines[0].uuid,
    type: 'assistant',
    sessionId: res.sessionId,
    message: { role: 'assistant', type: 'message', content: [{ type: 'text', text: '4' }] }
  })
  expect(typeof lines[0].version).toBe('string')
})

test('writeWebChatAsClaudeSession: 빈 대화 → error', () => {
  const res = writeWebChatAsClaudeSession({
    messages: [msg('user', '', 0)],
    cwd: '/tmp/wt',
    gitBranch: null,
    dirOverride: dir
  })
  expect('error' in res).toBe(true)
})
