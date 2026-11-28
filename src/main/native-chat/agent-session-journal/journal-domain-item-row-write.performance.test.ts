import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { runJournalTransaction } from './database/journal-database'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

// #51240: a heavy profile's main process wrote 34 GB in 7 h, mostly index pages. Every item
// save named every indexed column, so SQLite rewrote all of journal_items' indexes even when nothing
// they cover changed. Counts write-ahead-log pages per save; reverting the fix makes it 8.03.

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const CHATS = 20
const CALLS_PER_CHAT = 150

function toolCall(chat: number, call: number, revision: number): AgentJournalRenderItem {
  const head = `line\n`.repeat(40 + revision)
  return {
    itemId: `tool:${call}`,
    revision,
    sequence: 1 + call,
    observedAt: 1,
    turnScope: { kind: 'turn', turnItemId: `turn:${chat}` },
    body: {
      kind: 'tool-call',
      name: 'Bash',
      callId: `call-${chat}-${call}`,
      input: { command: `rg -n pattern src/${call}` },
      state: 'running',
      output: { head, byteLength: head.length, digest: `d${revision}`, truncated: false }
    }
  }
}

it('a save that leaves every indexed value unchanged writes one page', () => {
  const directory = mkdtempSync(join(tmpdir(), 'item-row-write-perf-'))
  directories.push(directory)
  const { db } = openJournalDomainDatabase(join(directory, 'journal.db'))
  db.pragma('wal_autocheckpoint = 0')
  const targets = Array.from({ length: CHATS }, (_, chat) => ({
    sessionId: `chat-${chat}`,
    epoch: 'epoch'
  }))
  for (const [chat, target] of targets.entries()) {
    db.prepare(
      `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace',?,?,1000,1)`
    ).run(target.sessionId, target.epoch)
    runJournalTransaction(db, () => {
      for (let call = 0; call < CALLS_PER_CHAT; call++) {
        writeJournalDomainCurrentItem(db, target, {
          item: toolCall(chat, call, 1),
          ordinal: call + 1,
          hidden: false,
          ownerFence: 1
        })
      }
    })
  }
  db.pragma('wal_checkpoint(TRUNCATE)')

  let saves = 0
  for (let revision = 2; revision < 7; revision++) {
    for (const [chat, target] of targets.entries()) {
      for (let call = 0; call < CALLS_PER_CHAT; call += 3) {
        runJournalTransaction(db, () =>
          writeJournalDomainCurrentItem(db, target, {
            item: toolCall(chat, call, revision),
            previous: {
              item: toolCall(chat, call, revision - 1),
              ordinal: call + 1,
              hidden: false
            },
            hidden: false,
            ownerFence: 1
          })
        )
        saves++
      }
    }
  }
  const frames = Number(db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()!.log)
  db.close()
  // One leaf page per save; the old every-column upsert wrote 8.03.
  expect(frames / saves).toBeLessThanOrEqual(1.1)
})
