import {
  openTestAgentSessionDatabase,
  withTestAgentSessionDatabase
} from '../../runtime/agent-session/records/agent-session-record-store-test-harness'
import { prWatchStorage, type PRWatchStorage } from './pr-watch-storage'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type {
  GitHubPRRefreshCandidate,
  PRRefreshOutcome
} from '../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { createTrackedJournalOpener } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { assemblePRRefreshFoundOutcome } from '../client/lookup/pr-refresh-outcome-assembly'
import type { PRWatchJob } from '../pull-requests/refresh/pr-refresh-watch-jobs'
import { readPRHeadCheckRollup } from './pr-head-check-read'
import { capturePRPendingActions } from './pr-pending-actions'
import { shellCallRow } from './pr-watch-test-fixtures'
import { PRWatchService } from './pr-watch-service'
import { prWatchCandidate, type PRWatchWorkspace } from './pr-watch-types'

// The PR read queue and GitHub are the boundary; everything from the observer inward is real.
type QueueObserver = (candidate: GitHubPRRefreshCandidate, outcome: PRRefreshOutcome) => void
type QueueHooks = {
  readHeadChecks: (job: Required<PRWatchJob>, candidate: GitHubPRRefreshCandidate) => unknown
}
const queue = vi.hoisted(() => {
  const state: {
    observers: Set<QueueObserver>
    hooks: QueueHooks | null
    scheduled: PRWatchJob[]
    pushReads: GitHubPRRefreshCandidate[]
  } = { observers: new Set(), hooks: null, scheduled: [], pushReads: [] }
  return state
})

vi.mock('../pull-requests/refresh/pr-refresh-coordinator', () => ({
  addPRRefreshOutcomeObserver: (observer: QueueObserver) => {
    queue.observers.add(observer)
    return () => queue.observers.delete(observer)
  },
  cancelPRWatchRead: () => {},
  enqueuePRRefresh: (candidate: GitHubPRRefreshCandidate) => queue.pushReads.push(candidate),
  schedulePRWatchRead: (job: PRWatchJob) => queue.scheduled.push(job),
  setPRWatchJobHooks: (hooks: QueueHooks | null) => {
    queue.hooks = hooks
  }
}))
vi.mock('./pr-head-check-read', () => ({
  readPRHeadCheckRollup: vi.fn(),
  resolvePRCommitSha: async () => null,
  isCommitInPRHead: async () => false
}))
vi.mock('../repositories/github-api-repository', () => ({
  resolveGitHubApiRepositoryCandidates: async () => ({
    candidates: [{ owner: 'acme', repo: 'repo', host: 'github.com' }]
  })
}))

const P_KEY = 'github.com/acme/repo#7'
const HEAD_A = '89abcde0000000000000000000000000000000aa'
const HEAD_B = 'c512e75000000000000000000000000000000bbb'
const WORKSPACE: PRWatchWorkspace = {
  repoId: 'repo-1',
  repoPath: '/repo',
  checkoutPath: '/repo',
  repoKind: 'git',
  branch: 'work',
  connectionId: null
}
const run = (status: string, conclusion: string | null) => ({
  __typename: 'CheckRun',
  name: 'build',
  databaseId: 31001,
  status,
  conclusion,
  checkSuite: { databaseId: 29001 }
})

let root: string
let database: PRWatchStorage
const journals = createTrackedJournalOpener()

function service(chatWorkspace: (chatId: string) => Promise<PRWatchWorkspace>): PRWatchService {
  return new PRWatchService({
    database,
    chatExists: () => true,
    chatFence: () => 0,
    chatWorkspace,
    openJournal: () => null,
    logger: { warn: () => {} }
  })
}

/** PR #7 as a read of its branch shows it: head `headSha`, its one check still running. */
function readOfP(headSha: string, final = false): PRRefreshOutcome {
  return assemblePRRefreshFoundOutcome({
    data: {
      number: 7,
      title: 'Fix',
      state: 'OPEN',
      url: 'https://github.com/acme/repo/pull/7',
      statusCheckRollup: [final ? run('COMPLETED', 'SUCCESS') : run('IN_PROGRESS', null)],
      checksUnavailable: false,
      updatedAt: '2026-11-06T00:00:00Z',
      mergeable: 'MERGEABLE',
      headRefName: 'review',
      headRefOid: headSha
    },
    dataRepo: { owner: 'acme', repo: 'repo' },
    dataHeadRepo: { owner: 'acme', repo: 'repo' },
    stack: undefined,
    mergeable: 'MERGEABLE',
    stackMergeQueueRequired: undefined,
    confirmedContainedHeadOid: null,
    headDivergedFromMergedPRAtOid: null,
    conflictSummary: undefined
  })
}

function observe(candidate: GitHubPRRefreshCandidate, outcome: PRRefreshOutcome): void {
  queue.observers.forEach((observer) => observer(candidate, outcome))
}

/** A chat's opened PR, verified by an earlier run: by default Q, an unrelated chat's recent PR. */
async function seedOpenedPR(chatId = 'chat-q', number = 5): Promise<PRWatchStorage> {
  await withTestAgentSessionDatabase(root, (db) =>
    capturePRPendingActions(
      db,
      chatId,
      [
        shellCallRow(
          `${chatId}-item`,
          'gh pr create --fill',
          `https://github.com/acme/repo/pull/${number}\n`
        )
      ],
      Date.now(),
      () => undefined
    )
  )
  const earlier = service(async () => WORKSPACE)
  await earlier.start()
  await vi.waitFor(async () =>
    expect(
      await withTestAgentSessionDatabase(root, (db) =>
        db.prepare('SELECT 1 FROM pr_pending_actions').get()
      )
    ).toBeUndefined()
  )
  earlier.stop()
  queue.scheduled.length = 0
  return database
}

describe('PRWatchService startup retirement', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'pr-watch-service-'))
    database = prWatchStorage(await openTestAgentSessionDatabase(root))
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_800_000_000_000)
    queue.observers.clear()
    queue.scheduled.length = 0
    queue.pushReads.length = 0
  })

  afterEach(async () => {
    vi.useRealTimers()
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  it.each([false, true])(
    'orders back-to-back SQL outcomes across a deferred acknowledgement (stop=%s)',
    async (stop) => {
      await seedOpenedPR('chat-p', 7)
      await withTestAgentSessionDatabase(root, (db) =>
        capturePRPendingActions(
          db,
          'chat-p',
          [
            shellCallRow(
              'ordered-push',
              'git push origin work:review',
              'To github.com:acme/repo.git\n   1234567..89abcde  work -> review\n'
            )
          ],
          Date.now(),
          () => undefined
        )
      )
      const saved = database
      const committed = Promise.withResolvers<void>()
      const acknowledged = Promise.withResolvers<void>()
      database = {
        ...saved,
        async write(operation) {
          const result = await saved.write(operation)
          if (
            operation.kind === 'settle' &&
            operation.verified.some(({ action }) => action.headSha === HEAD_A)
          ) {
            committed.resolve()
            await acknowledged.promise
          }
          return result
        }
      }
      const watching = service(async () => WORKSPACE)
      try {
        await watching.start()
        await vi.waitFor(() => expect(queue.pushReads).toHaveLength(1))
        const candidate = prWatchCandidate(WORKSPACE, 7)
        observe(candidate, readOfP(HEAD_A, true))
        observe(candidate, readOfP(HEAD_B, true))
        await committed.promise
        const events = () =>
          withTestAgentSessionDatabase(root, (db) =>
            db.prepare('SELECT head_sha,verdict,occurrence FROM pr_check_events ORDER BY id').all()
          )
        expect(
          (await saved.read({ kind: 'heads', prKey: P_KEY })).map(({ headSha }) => headSha)
        ).toEqual([HEAD_A])
        expect(await events()).toEqual([])
        if (stop) {
          watching.stop()
        }
        acknowledged.resolve()
        // Stopped observers finish on microtasks; no further SQL is admitted after the held ack.
        await new Promise<void>((resolve) => setImmediate(resolve))
        await vi.waitFor(async () =>
          expect(await events()).toEqual(
            stop
              ? []
              : [
                  { head_sha: HEAD_A, verdict: 'success', occurrence: 1 },
                  { head_sha: HEAD_B, verdict: 'success', occurrence: 1 }
                ]
          )
        )
        expect(await saved.read({ kind: 'owed-chats' })).toEqual(stop ? [] : ['chat-p'])
        expect(
          await withTestAgentSessionDatabase(root, (db) =>
            db
              .prepare(
                'SELECT head_sha,context,last_state,last_run_id FROM pr_check_contexts ORDER BY head_sha'
              )
              .all()
          )
        ).toEqual(
          stop
            ? []
            : [
                {
                  head_sha: HEAD_A,
                  context: 'check:29001:build',
                  last_state: 'passed',
                  last_run_id: '31001'
                },
                {
                  head_sha: HEAD_B,
                  context: 'check:29001:build',
                  last_state: 'passed',
                  last_run_id: '31001'
                }
              ]
        )
      } finally {
        acknowledged.resolve()
        watching.stop()
        database = saved
      }
    }
  )

  it('keeps a push verified while startup waits, so its earlier head still reports', async () => {
    await seedOpenedPR()

    // P: chat-p's push to `review`, captured with its call and not yet verified.
    const journal = await journals.open({
      identity: {
        sessionId: 'chat-p',
        workspaceId: 'ws-1',
        hostId: 'host-1',
        agent: 'codex',
        providerHandle: codexProviderHandle('thread-1')
      },
      stateDirectory: root,
      now: () => Date.now(),
      mintEpoch: () => 'epoch-1'
    })
    const push = shellCallRow(
      'p-item',
      'git push origin work:review',
      'To github.com:acme/repo.git\n   1234567..89abcde  work -> review\n'
    )
    const pushCommit = await journal.write({
      kind: 'item',
      identity: { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal: 0 },
      body: push.body,
      options: { fence: 0, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    })

    // A fresh start, held on Q's workspace.
    let releaseQ = (_workspace: PRWatchWorkspace) => {}
    const qWorkspace = new Promise<PRWatchWorkspace>((resolve) => (releaseQ = resolve))
    const restarted = service((chatId) =>
      chatId === 'chat-q' ? qWorkspace : Promise.resolve(WORKSPACE)
    )
    const starting = restarted.start()

    // P's call finishes in a committed batch; its push read proves head A, CI still running.
    restarted.observeCommittedRows('chat-p', journal, pushCommit)
    await vi.waitFor(() => expect(queue.pushReads).toHaveLength(1))
    observe(queue.pushReads[0]!, readOfP(HEAD_A))
    await vi.waitFor(async () =>
      expect(
        (await database.read({ kind: 'heads', prKey: P_KEY })).map((head) => head.headSha)
      ).toEqual([HEAD_A])
    )

    releaseQ(WORKSPACE)
    await starting

    // The next read already shows B; A was never read again as the current head.
    observe(queue.pushReads[0]!, readOfP(HEAD_B))
    await vi.waitFor(async () =>
      expect(
        await withTestAgentSessionDatabase(root, (db) =>
          db
            .prepare('SELECT head_sha FROM pr_pending_heads WHERE pr_key=? AND moved_at IS NULL')
            .get(P_KEY)
        )
      ).toMatchObject({ head_sha: HEAD_B })
    )
    restarted.stop()

    // After a restart A is still read by its SHA, and its final result reaches chat-p.
    queue.scheduled.length = 0
    const next = service(async () => WORKSPACE)
    await next.start()
    expect(queue.scheduled).toContainEqual({ prKey: P_KEY, headSha: HEAD_A })
    vi.mocked(readPRHeadCheckRollup).mockResolvedValue([run('COMPLETED', 'SUCCESS')])
    await queue.hooks?.readHeadChecks({ prKey: P_KEY, headSha: HEAD_A }, queue.pushReads[0]!)
    expect(await database.read({ kind: 'owed-chats' })).toEqual(['chat-p'])
    expect(
      await withTestAgentSessionDatabase(root, (db) =>
        db.prepare('SELECT head_sha, verdict FROM pr_check_events').all()
      )
    ).toEqual([{ head_sha: HEAD_A, verdict: 'success' }])
    next.stop()
  })
})
