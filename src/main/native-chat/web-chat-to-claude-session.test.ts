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
    messages: [msg('user', '2+2?', 1000), msg('assistant', '4', 2000)],
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
    timestamp: new Date(1000).toISOString(),
    message: { role: 'user', content: '2+2?' }
  })
  expect(lines[1]).toMatchObject({
    parentUuid: lines[0].uuid,
    type: 'assistant',
    sessionId: res.sessionId,
    timestamp: new Date(2000).toISOString(),
    message: {
      role: 'assistant',
      type: 'message',
      model: 'claude-opus-4-8',
      content: [{ type: 'text', text: '4' }]
    }
  })
  // 메시지별 timestamp를 각자 반영해야 함(하나의 now로 뭉개면 안 됨) — 순서 보존의 핵심.
  expect(lines[0].timestamp).not.toBe(lines[1].timestamp)
  expect(typeof lines[0].version).toBe('string')
})

test('writeWebChatAsClaudeSession: timestamp가 null이면 현재 시각으로 대체', () => {
  const res = writeWebChatAsClaudeSession({
    messages: [
      {
        id: 'm0',
        role: 'user',
        blocks: [{ type: 'text', text: 'hi' }],
        timestamp: null,
        source: 'transcript'
      }
    ],
    cwd: '/tmp/wt',
    gitBranch: null,
    dirOverride: dir
  })
  if (!('sessionId' in res)) {
    throw new Error('expected sessionId')
  }
  const files = readdirSync(dir)
  const [line] = readFileSync(join(dir, files[0]), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  expect(typeof line.timestamp).toBe('string')
  expect(Number.isNaN(Date.parse(line.timestamp))).toBe(false)
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

test('writeWebChatAsClaudeSession: timestamp가 범위 밖(RangeError 유발)이어도 throw 대신 {error} 반환', () => {
  // Date 생성자는 8.64e15ms를 넘는 값에서 Invalid Date가 아니라 RangeError를 던진다.
  // 레코드 빌딩이 try 밖에 있으면 여기서 그대로 throw되어 호출자의 error→seed 폴백이 못 돈다.
  const res = writeWebChatAsClaudeSession({
    messages: [msg('user', 'hi', 8.7e15)],
    cwd: '/tmp/wt',
    gitBranch: null,
    dirOverride: dir
  })
  expect('error' in res).toBe(true)
})
