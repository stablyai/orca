import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  forgetOwedRunChatCards,
  oweRunChatCards,
  owedRunChatCards
} from './bot-run-chat-owed-cards-store'

describe("closed run chats' owed cards", () => {
  // A real temp directory, so the database is closed and opened again as across a restart.
  const roots: string[] = []
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

  it("keeps each bot's owed chats once, across a reopen, until they are forgotten", () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-owed-cards-'))
    roots.push(root)
    const path = join(root, 'orchestration.db')
    const first = new OrchestrationDb(path)
    oweRunChatCards(first, 'bot-1', 'chat-a')
    oweRunChatCards(first, 'bot-1', 'chat-a')
    oweRunChatCards(first, 'bot-2', 'chat-b')
    first.close()

    const reopened = new OrchestrationDb(path)
    try {
      expect(owedRunChatCards(reopened, 'bot-1')).toEqual(['chat-a'])
      expect(owedRunChatCards(reopened, 'bot-2')).toEqual(['chat-b'])
      forgetOwedRunChatCards(reopened, 'chat-a')
      expect(owedRunChatCards(reopened, 'bot-1')).toEqual([])
      expect(owedRunChatCards(reopened, 'bot-2')).toEqual(['chat-b'])
    } finally {
      reopened.close()
    }
  })
})
