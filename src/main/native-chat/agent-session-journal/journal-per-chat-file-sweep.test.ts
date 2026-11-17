import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionLogger } from '../agent-session-wire/host/structured-agent-session-logger'
import { sweepPerChatJournalFiles } from './journal-per-chat-file-sweep'

// sha256(...).slice(0, 32), the per-chat layout's folder names.
const WORKSPACE = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const KEPT_CHAT = '676ecb5b40156a08674686b7da605edc' // "kept-chat"
const GONE_CHAT = '028a0199936463168f01de0db7fd1c2b' // "gone-chat"
const TRANSCRIPT_CHAT = '0985bbdc59c2e2cd6f019e913ca9dc9b' // "old-transcript-chat"

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function perChatFolder(state: string, chat: string, files: readonly string[]): string {
  const folder = join(state, 'agent-session-journal', WORKSPACE, chat)
  mkdirSync(folder, { recursive: true })
  for (const name of files) {
    writeFileSync(join(folder, name), 'x')
  }
  return folder
}

const logger = { warn: vi.fn() } as unknown as StructuredAgentSessionLogger

it('deletes the journal files of chats without a record and keeps everything else', async () => {
  const state = mkdtempSync(join(tmpdir(), 'orca-per-chat-sweep-'))
  scratch.push(state)
  const journal = ['journal.db', 'journal.db-wal', 'journal.db-shm']
  const kept = perChatFolder(state, KEPT_CHAT, journal)
  perChatFolder(state, GONE_CHAT, journal)
  const transcript = perChatFolder(state, TRANSCRIPT_CHAT, [...journal, 'log.jsonl'])

  const result = await sweepPerChatJournalFiles({
    stateDirectory: state,
    listHeldSessionIds: () => ['kept-chat'],
    logger
  })

  expect(result).toEqual({ removed: 2, failed: 0 })
  expect(readdirSync(kept).sort()).toEqual(['journal.db', 'journal.db-shm', 'journal.db-wal'])
  expect(readdirSync(join(state, 'agent-session-journal', WORKSPACE)).sort()).toEqual([
    TRANSCRIPT_CHAT,
    KEPT_CHAT
  ])
  expect(readdirSync(transcript)).toEqual(['log.jsonl'])
})

it('deletes nothing when the chat roster cannot be read', async () => {
  const state = mkdtempSync(join(tmpdir(), 'orca-per-chat-sweep-'))
  scratch.push(state)
  const gone = perChatFolder(state, GONE_CHAT, ['journal.db'])

  await sweepPerChatJournalFiles({ stateDirectory: state, listHeldSessionIds: () => null, logger })

  expect(existsSync(join(gone, 'journal.db'))).toBe(true)
})
