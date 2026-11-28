import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import {
  forgetUnfinishedRunChatClose,
  recordUnfinishedRunChatClose,
  unfinishedRunChatCloses
} from './bot-run-chat-unfinished-closes-store'

describe("closed run chats' unfinished closes", () => {
  // A real temp directory, so the database is closed and opened again as across a restart.
  const roots: string[] = []
  afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

  it("keeps each bot's unfinished closes once, across a reopen, until they are forgotten", () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-unfinished-closes-'))
    roots.push(root)
    const path = join(root, 'orchestration.db')
    const first = new OrchestrationDb(path)
    recordUnfinishedRunChatClose(first, 'bot-1', 'chat-a')
    recordUnfinishedRunChatClose(first, 'bot-1', 'chat-a')
    recordUnfinishedRunChatClose(first, 'bot-2', 'chat-b')
    first.close()

    const reopened = new OrchestrationDb(path)
    try {
      expect(unfinishedRunChatCloses(reopened, 'bot-1')).toEqual(['chat-a'])
      expect(unfinishedRunChatCloses(reopened, 'bot-2')).toEqual(['chat-b'])
      forgetUnfinishedRunChatClose(reopened, 'chat-a')
      expect(unfinishedRunChatCloses(reopened, 'bot-1')).toEqual([])
      expect(unfinishedRunChatCloses(reopened, 'bot-2')).toEqual(['chat-b'])
    } finally {
      reopened.close()
    }
  })
})
