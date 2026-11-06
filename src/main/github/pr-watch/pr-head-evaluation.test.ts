import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database'
import { endPRWatchState, readPRPendingHeads } from './pr-check-event-tables'
import { recordPRChatAction, recordPRHeadObservation } from './pr-head-evaluation'
import { deletePRWatchChats } from './pr-watch-tables'
import { PRChatActionRecorder } from './pr-chat-action-recorder'
import { prWatchCandidate } from './pr-watch-types'

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

describe('a replayed or superseded push head', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pr-head-replay-'))
    database = openTestJournalHostDatabase(root)
  })

  afterEach(async () => {
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  it('seeds a replayed action’s already-final first read without a line', () => {
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
    const first = recordPRHeadObservation(database, {
      prKey: PR_KEY,
      headSha: HEAD_A,
      rollup: green(31001),
      isCurrentHead: true,
      observedAt: 10,
      silent: true
    })
    expect(first.chatIds).toEqual([])
    // A later result on that head is new and reported as usual.
    expect(
      recordPRHeadObservation(database, {
        prKey: PR_KEY,
        headSha: HEAD_A,
        rollup: green(31009),
        isCurrentHead: true,
        observedAt: 20
      }).chatIds
    ).toEqual(['chat-1'])
  })

  it('keys a superseded push by its full SHA, so a force-push back repeats nothing', async () => {
    const fullA = '89abcde0000000000000000000000000000000ff'
    const recorded: { headSha: string | null; superseded: boolean }[] = []
    const workspace = {
      repoId: 'r',
      repoPath: '/repo',
      checkoutPath: '/repo',
      repoKind: 'git' as const,
      branch: 'work',
      connectionId: null
    }
    const recorder = new PRChatActionRecorder({
      chatWorkspace: async () => workspace,
      isRecorded: () => false,
      repositories: async () => [],
      readAfterPush: () => {},
      resolveCommitSha: async (_candidate, _pr, abbreviated) =>
        fullA.startsWith(abbreviated) ? fullA : null,
      record: (action, _candidate, how) => {
        recorded.push({ headSha: action.headSha, superseded: how.superseded })
        recordPRChatAction(database, action, how.superseded ? 50 : null)
      },
      now: () => 0
    })
    await recorder.record([
      {
        chatId: 'chat-1',
        anchor: { itemId: 'item', revision: 1 },
        script: 'git push origin work:review',
        output: 'To github.com:acme/repo.git\n   1234567..89abcde  work -> review\n',
        finishedAt: 0
      }
    ])
    // Another push moved the PR to B before the first read.
    recorder.verify(
      prWatchCandidate(workspace, null),
      {
        number: 3,
        headRefName: 'review',
        headSha: HEAD_B,
        headRepo: { owner: 'acme', repo: 'repo' },
        prRepo: { owner: 'acme', repo: 'repo' }
      } as PRInfo,
      40
    )
    await vi.waitFor(() => expect(recorded).toEqual([{ headSha: fullA, superseded: true }]))
    recorder.clear()
    // The earlier head's own read reports it once; the PR later returning to A repeats nothing.
    expect(
      recordPRHeadObservation(database, {
        prKey: PR_KEY,
        headSha: fullA,
        rollup: green(31001),
        isCurrentHead: false,
        observedAt: 60
      }).chatIds
    ).toEqual(['chat-1'])
    expect(read(fullA, green(31001), 70)).toEqual([])
  })
})
