import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestAgentSessionRecordStores,
  openTestAgentSessionDatabase,
  withTestAgentSessionDatabase
} from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { prWatchStorage, type PRWatchStorage } from './pr-watch-storage'
import { recordPRChatAction } from './pr-head-evaluation'
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
let database: PRWatchStorage

async function seedOpenedChat(chatId: string): Promise<void> {
  await withTestAgentSessionDatabase(root, (db) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      recordPRChatAction(db, {
        chatId,
        anchor: { itemId: 'orca:anchor', revision: 1 },
        forgeHost: 'github.com',
        owner: 'acme',
        repo: 'repo',
        number: 3,
        kind: 'opened',
        headSha: null,
        observedAt: 0
      })
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  })
}

async function read(headSha: string, rollup: unknown[], observedAt = 10): Promise<string[]> {
  return (
    await database.write({
      kind: 'head',
      read: {
        prKey: PR_KEY,
        headSha,
        rollup,
        isCurrentHead: true,
        observedAt
      }
    })
  ).chatIds
}

describe('recordPRHeadObservation over saved state', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pr-head-evaluation-'))
    database = prWatchStorage(await openTestAgentSessionDatabase(root))
    await seedOpenedChat('chat-1')
  })

  afterEach(async () => {
    await closeTestAgentSessionRecordStores()
    await rm(root, { recursive: true, force: true })
  })

  it('never reports a result again after its watch ends and a restart reads it anew', async () => {
    expect(await read(HEAD_A, green(31001))).toEqual(['chat-1'])
    // The PR merged: the watch ended. A restart's first read sees the same final result.
    await database.write({ kind: 'end', prKey: PR_KEY })
    expect(await read(HEAD_A, green(31001), 20)).toEqual([])
    // A force-push away and back to the same head is no new result either.
    expect(await read(HEAD_B, green(31002), 30)).toEqual(['chat-1'])
    expect(await read(HEAD_A, green(31001), 40)).toEqual([])
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
async function capturePushAndResume(
  readAfterPush = async () => {}
): Promise<PRPendingActionResume> {
  await withTestAgentSessionDatabase(root, (db) =>
    capturePRPendingActions(
      db,
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
    settle: (row, indices, verified) => database.write({ kind: 'settle', row, indices, verified }),
    logger: { warn: () => {} },
    now: () => 10
  })
}

describe('a superseded push head and startup', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pr-head-replay-'))
    database = prWatchStorage(await openTestAgentSessionDatabase(root))
  })

  afterEach(async () => {
    await closeTestAgentSessionRecordStores()
    await rm(root, { recursive: true, force: true })
  })

  it('saves a pusher before the read that verified it is evaluated', async () => {
    await seedOpenedChat('chat-0')
    const readAfterPush = vi.fn()
    const resume = await capturePushAndResume(readAfterPush)
    resume.drain()
    await vi.waitFor(() => expect(readAfterPush).toHaveBeenCalled())
    // Verification is acknowledged before the same read is evaluated.
    await resume.verifyRead(prWatchCandidate(WORKSPACE, null), { ...MOVED_ON, headSha: FULL_A }, 40)
    expect((await read(FULL_A, green(31001), 40)).sort()).toEqual(['chat-0', 'chat-1'])
    resume.clear()
  })

  it('keys a superseded push by its full SHA, so a force-push back repeats nothing', async () => {
    const fullA = FULL_A
    const resume = await capturePushAndResume()
    resume.drain()
    // Another push moved the PR to B before the first read.
    await vi.waitFor(async () => {
      await resume.verifyRead(prWatchCandidate(WORKSPACE, null), MOVED_ON, 40)
      expect(
        (await database.read({ kind: 'heads', prKey: PR_KEY })).map((head) => head.headSha)
      ).toEqual([fullA])
    })
    resume.clear()
    // The earlier head's own read reports it once; the PR later returning to A repeats nothing.
    expect(
      (
        await database.write({
          kind: 'head',
          read: {
            prKey: PR_KEY,
            headSha: fullA,
            rollup: green(31001),
            isCurrentHead: false,
            observedAt: 60
          }
        })
      ).chatIds
    ).toEqual(['chat-1'])
    expect(await read(fullA, green(31001), 70)).toEqual([])
  })
})
