import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/database/journal-host-database'
import { endPRWatchState, readPRPendingHeads } from './pr-check-event-tables'
import {
  recordPRChatAction,
  recordPRHeadObservation,
  settlePRPendingObligations
} from './pr-head-evaluation'
import { PRPendingActionResume } from './pr-pending-action-resume'
import { capturePRPendingActions } from './pr-pending-actions'
import './pr-watch-tables'
import { prInfoFixture, shellCallRow } from './pr-watch-test-fixtures'
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
})

const FULL_A = '89abcde0000000000000000000000000000000ff'
const WORKSPACE = {
  repoId: 'r',
  repoPath: '/repo',
  checkoutPath: '/repo',
  repoKind: 'git' as const,
  branch: 'work',
  connectionId: null
}
const MOVED_ON = prInfoFixture({
  number: 3,
  headRefName: 'review',
  headSha: HEAD_B,
  headRepo: { owner: 'acme', repo: 'repo' },
  prRepo: { owner: 'acme', repo: 'repo' }
})

/** chat-1's captured `git push origin work:review`, resumed and awaiting its PR read. */
function capturePushAndResume(readAfterPush = () => {}): PRPendingActionResume {
  capturePRPendingActions(
    database.db,
    'chat-1',
    [
      shellCallRow(
        'item',
        'git push origin work:review',
        'To github.com:acme/repo.git\n   1234567..89abcde  work -> review\n'
      )
    ],
    0,
    () => undefined
  )
  return new PRPendingActionResume({
    database,
    chatExists: () => true,
    chatWorkspace: async () => WORKSPACE,
    repositories: async () => [],
    resolvePushRemote: async () => ({ host: 'github.com', owner: 'acme', repo: 'repo' }),
    readAfterPush,
    resolveCommitSha: async (_candidate, _pr, abbreviated) =>
      FULL_A.startsWith(abbreviated) ? FULL_A : null,
    isCommitInPRHead: async () => false,
    settle: (row, indices, verified) =>
      settlePRPendingObligations(database, row, indices, verified),
    logger: { warn: () => {} },
    now: () => 10
  })
}

describe('a superseded push head and startup', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pr-head-replay-'))
    database = openTestJournalHostDatabase(root)
  })

  afterEach(async () => {
    await closeTestJournalHostDatabases()
    await rm(root, { recursive: true, force: true })
  })

  it('saves a pusher before the read that verified it is evaluated', async () => {
    recordPRChatAction(database, {
      chatId: 'chat-0',
      anchor: { itemId: 'orca:anchor', revision: 1 },
      forgeHost: 'github.com',
      owner: 'acme',
      repo: 'repo',
      number: 3,
      kind: 'opened',
      headSha: null,
      observedAt: 0
    })
    const readAfterPush = vi.fn()
    const resume = capturePushAndResume(readAfterPush)
    resume.drain()
    await vi.waitFor(() => expect(readAfterPush).toHaveBeenCalled())
    // The observer's order: verify, then evaluate the same read, with no await between them.
    resume.verifyRead(prWatchCandidate(WORKSPACE, null), { ...MOVED_ON, headSha: FULL_A }, 40)
    expect(read(FULL_A, green(31001), 40).sort()).toEqual(['chat-0', 'chat-1'])
    resume.clear()
  })

  it('keys a superseded push by its full SHA, so a force-push back repeats nothing', async () => {
    const fullA = FULL_A
    const resume = capturePushAndResume()
    resume.drain()
    // Another push moved the PR to B before the first read.
    await vi.waitFor(() => {
      resume.verifyRead(prWatchCandidate(WORKSPACE, null), MOVED_ON, 40)
      expect(readPRPendingHeads(database.db, PR_KEY).map((head) => head.headSha)).toEqual([fullA])
    })
    resume.clear()
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
