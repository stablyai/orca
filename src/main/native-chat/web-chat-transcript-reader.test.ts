import { afterEach, beforeEach, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import SyncDatabase from '../sqlite/sync-database'
import { initChatImportSchema } from '../chat-import/chat-import-schema'
import { readWebChatConversation, isWebChatAgentString } from './web-chat-transcript-reader'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'webchat-reader-'))
  dbPath = join(dir, 'chats.db')
  const db = new SyncDatabase(dbPath)
  initChatImportSchema(db)
  db.prepare(
    'INSERT INTO conversations(id, source, external_id, title, synced_at) VALUES (?,?,?,?,?)'
  ).run('GEMINI/c_1', 'GEMINI', 'c_1', '표 대화', '2026-07-13T00:00:00.000Z')
  const ins = db.prepare(
    'INSERT INTO messages(id, conv_id, role, idx, text, created_at) VALUES (?,?,?,?,?,?)'
  )
  ins.run('GEMINI/c_1#0', 'GEMINI/c_1', 'USER', 0, '표 만들어줘', '2026-07-13T00:00:01.000Z')
  ins.run(
    'GEMINI/c_1#1',
    'GEMINI/c_1',
    'AI',
    1,
    '| a | b |\n|---|---|\n| 1 | 2 |',
    '2026-07-13T00:00:02.000Z'
  )
  db.close()
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('isWebChatAgentString: 웹 agent만 true', () => {
  expect(isWebChatAgentString('gemini-web')).toBe(true)
  expect(isWebChatAgentString('claude')).toBe(false)
})

test('readWebChatConversation: 대화를 NativeChatMessage[]로 변환', () => {
  const result = readWebChatConversation('gemini-web', 'c_1', dbPath)
  expect('messages' in result).toBe(true)
  if (!('messages' in result)) {
    throw new Error('expected messages')
  }
  expect(result.messages).toEqual([
    {
      id: 'GEMINI/c_1#0',
      role: 'user',
      blocks: [{ type: 'text', text: '표 만들어줘' }],
      timestamp: Date.parse('2026-07-13T00:00:01.000Z'),
      source: 'transcript'
    },
    {
      id: 'GEMINI/c_1#1',
      role: 'assistant',
      blocks: [{ type: 'text', text: '| a | b |\n|---|---|\n| 1 | 2 |' }],
      timestamp: Date.parse('2026-07-13T00:00:02.000Z'),
      source: 'transcript'
    }
  ])
})

test('readWebChatConversation: DB 부재 → 빈 메시지', () => {
  const result = readWebChatConversation('gemini-web', 'c_1', join(dir, 'nope.db'))
  expect(result).toEqual({ messages: [] })
})
