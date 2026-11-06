import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database'
import { endPRWatchState, readPRPendingHeads } from './pr-check-event-tables'
import { recordPRChatAction, recordPRHeadObservation } from './pr-head-evaluation'
import { deletePRWatchChats } from './pr-watch-tables'

const PR_KEY = 'github.com/acme/repo#3'
const HEAD_A = '8d5f74b3c0e1d2f3'
const HEAD_B = 'c512e75aa0b1c2d3'
const green = (runId: number) => [
  {
    __typename: 'CheckRun',
    name: 'build',
    databaseId: runId,
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    checkSuite: { databaseId: 29001 }
  }
]

let root: string
let database: JournalHostDatabase

function read(headSha: string, rollup: unknown[], observedAt = 10): string[] {
  return recordPRHeadObservation(database, {
    prKey: PR_KEY,
    headSha,
    rollup,
    isCurrentHead: true,
    observedAt
  }).chatIds
}

describe('recordPRHeadObservation over saved state', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pr-head-evaluation-'))
    database = openTestJournalHostDatabase(root)
    recordPRChatAction(database, {
      chatId: 'chat-1',
      anchor: { itemId: 'orca:anchor', revision: 1 },
      forgeHost: 'github.com',
      owner: 'acme',
      repo: 'repo',
      number: 3,
      kind: 'opened',
      headSha: null,
      observedAt: 0
    })
  })

  afterEach(async () => {
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  it('never reports a result again after its watch ends and a restart reads it anew', () => {
    expect(read(HEAD_A, green(31001))).toEqual(['chat-1'])
    // The PR merged: the watch ended. A restart's first read sees the same final result.
    database.transaction((db) => endPRWatchState(db, PR_KEY))
    expect(read(HEAD_A, green(31001), 20)).toEqual([])
    // A force-push away and back to the same head is no new result either.
    expect(read(HEAD_B, green(31002), 30)).toEqual(['chat-1'])
    expect(read(HEAD_A, green(31001), 40)).toEqual([])
  })

  it('drops heads and context memory with the PR’s last owning chat', () => {
    read(HEAD_A, [{ ...green(31001)[0], status: 'IN_PROGRESS', conclusion: null }])
    expect(readPRPendingHeads(database.db, PR_KEY)).toHaveLength(1)
    database.transaction((db) => deletePRWatchChats(db, ['chat-1']))
    expect(readPRPendingHeads(database.db, PR_KEY)).toEqual([])
    const contexts = database.db.prepare('SELECT COUNT(*) AS n FROM pr_check_contexts').get() as {
      n: number
    }
    expect(contexts.n).toBe(0)
  })
})
