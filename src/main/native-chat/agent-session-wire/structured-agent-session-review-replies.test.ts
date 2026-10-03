// A launch prompt's review reply (resolve the threads, post Orca's "fixing" replies) runs once the
// agent takes the message: never before, never for a message no agent took, and once across a
// restart, derived from the chat itself.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionReviewReply } from '../../../shared/agent-session-review-reply'
import type { PRComment } from '../../../shared/github/comment-types'
import type { ReviewReplyPosts } from '../../github/client/fetch/review-reply-posts'
import {
  AGENT_SESSION_REVIEW_REPLY_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../shared/protocol-version'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../runtime/agent-session-record-store-test-harness'
import {
  AgentSessionPreSpawnError,
  type StructuredAgentSessionAdapter
} from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestAttachParams,
  hostTestMessage,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { attachForTests } from './structured-agent-session-attach-test-support'
import {
  REVIEW_REPLY_WINDOW_MS,
  reviewReplyReceiptIdentity
} from './structured-agent-session-review-replies'
import {
  REVIEW_REPLY_CLOCK_MARGIN_MS,
  type StructuredAgentSessionReviewRuntime
} from './structured-agent-session-review-reply-runner'

const CALLER = { callerKey: 'client-1' }
const FIXING = 'Fixing. Will be in the next commit'
const GITHUB: AgentSessionReviewReply = {
  provider: 'github',
  repoId: 'repo-1',
  prNumber: 42,
  prRepo: { owner: 'acme', repo: 'app' },
  resolve: ['thread-resolvable'],
  replies: [{ commentId: 7, threadId: 'thread-7', path: 'src/a.ts', line: 3 }],
  replyBody: FIXING,
  conversationReply: 'Fixing the review summary.'
}

function eventually(assertion: () => void | Promise<void>): Promise<void> {
  return vi.waitFor(assertion, { timeout: 10_000 })
}

let root: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
let beforeSpawn = vi.fn<() => Promise<void>>()
let dispatch = vi.fn<StructuredAgentSessionAdapter['dispatch']>()
let warnings: string[] = []
let onPR: ReviewReplyPosts = { viewerLogin: 'me', threads: {}, conversation: [] }
let review: {
  [Method in keyof StructuredAgentSessionReviewRuntime]: ReturnType<
    typeof vi.fn<StructuredAgentSessionReviewRuntime[Method]>
  >
}

function reviewRuntime() {
  return {
    resolveRepoReviewThread: vi.fn<StructuredAgentSessionReviewRuntime['resolveRepoReviewThread']>(
      async () => true
    ),
    resolveGitLabRepoMRDiscussion: vi.fn<
      StructuredAgentSessionReviewRuntime['resolveGitLabRepoMRDiscussion']
    >(async () => ({ ok: true as const })),
    addRepoPRReviewCommentReply: vi.fn<
      StructuredAgentSessionReviewRuntime['addRepoPRReviewCommentReply']
    >(async () => ({ ok: true as const, comment: postedComment(FIXING) })),
    addRepoIssueComment: vi.fn<StructuredAgentSessionReviewRuntime['addRepoIssueComment']>(
      async () => ({ ok: true as const, comment: postedComment('summary') })
    ),
    getRepoReviewReplyPosts: vi.fn<StructuredAgentSessionReviewRuntime['getRepoReviewReplyPosts']>(
      async () => onPR
    ),
    reviewWritten: vi.fn<StructuredAgentSessionReviewRuntime['reviewWritten']>(async () => {})
  }
}

function postedComment(body: string, extra: Partial<PRComment> = {}): PRComment {
  return {
    id: 900,
    author: 'me',
    authorAvatarUrl: '',
    body,
    createdAt: new Date().toISOString(),
    url: 'https://github.com/acme/app/pull/42#discussion_r900',
    ...extra
  }
}

function startHost(): void {
  host = new StructuredAgentSessionHost({
    logger: { warn: (message) => warnings.push(message), error: vi.fn() },
    store,
    adapter: {
      acquire: vi.fn(async ({ fence, spawnToken }) => {
        await beforeSpawn()
        return {
          process: {
            hostId: 'local',
            pid: 4242,
            processStartTimeMs: 1_700_000_000_000,
            spawnToken
          },
          link: {
            linkId: `link-${fence}`,
            handle: { provider: 'codex' as const, threadId: THREAD },
            origin: store.getRecord(SESSION)?.providerHandleChain.length
              ? ('resumed' as const)
              : ('created' as const),
            mintedAtFence: fence,
            observedAt: NOW
          },
          acquisitionGeneration: `generation-${fence}`
        }
      }),
      releaseAcquisition: vi.fn(async () => true),
      dispatch,
      cancelTurn: vi.fn(async () => ({ cancelled: true })),
      answerPrompt: vi.fn(async () => undefined),
      setOption: vi.fn(async () => undefined)
    },
    journalDatabase: openTestJournalHostDatabase(root),
    claimKeyId: 'key-1',
    mintSpawnToken: () => `spawn-${beforeSpawn.mock.calls.length + 1}`,
    now: () => NOW,
    setStartRetryTimer: () => () => {},
    reviewRuntime: review
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-review-replies-'))
  resetHostTestOperationIds()
  onPR = { viewerLogin: 'me', threads: {}, conversation: [] }
  warnings = []
  review = reviewRuntime()
  beforeSpawn = vi.fn(async () => undefined)
  dispatch = vi.fn(async () => ({ state: 'admitted' as const }))
  store = await openTestAgentSessionRecordStore(root)
  startHost()
  await expect(
    attachForTests(host, CALLER, hostTestAttachParams(null, { providerHandle: undefined }))
  ).resolves.toMatchObject({ ok: true })
  // At rest, so each message starts the agent, as a new chat's first one does.
  await host.close(SESSION, 'evict')
  beforeSpawn.mockClear()
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(root, { recursive: true, force: true })
})

/** Lets whatever the last commits set off run, short of a quit. */
async function settled(): Promise<void> {
  await host.flushStreamedEvents(SESSION)
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function fence(): number {
  return store.getRecord(SESSION)?.lease.runtimeFence ?? 0
}

function sendParams(text: string, reviewReply: AgentSessionReviewReply, clientOperationId: string) {
  const body = hostTestMessage(text)
  return {
    envelope: {
      sessionId: SESSION,
      clientOperationId,
      expectedRuntimeFence: fence(),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body, reviewReply }
      })
    },
    body,
    reviewReply,
    userSend: true as const
  }
}

async function launchPrompt(reviewReply: AgentSessionReviewReply = GITHUB): Promise<string> {
  const sent = await host.send(
    CALLER,
    sendParams('resolve these', reviewReply, hostTestOperationId())
  )
  expect(sent).toMatchObject({ ok: true })
  return sent.ok ? sent.value.clientMessageId : ''
}

async function submission(clientMessageId: string): Promise<AgentJournalSubmission | undefined> {
  return (await host.journalSnapshot(SESSION)).submissions.find(
    (entry) => entry.clientMessageId === clientMessageId
  )
}

async function handedOver(clientMessageId: string): Promise<void> {
  await eventually(async () =>
    expect(dispatch.mock.calls.map(([input]) => input.clientMessageId)).toContain(clientMessageId)
  )
}

function accept(clientMessageId: string) {
  return host.settleLateDispatch({
    sessionId: SESSION,
    clientMessageId,
    providerIdentity: { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 0 }
  })
}

function writes(): number {
  return (
    review.resolveRepoReviewThread.mock.calls.length +
    review.resolveGitLabRepoMRDiscussion.mock.calls.length +
    review.addRepoPRReviewCommentReply.mock.calls.length +
    review.addRepoIssueComment.mock.calls.length
  )
}

/** Whether the chat holds the message's receipt, and the line it shows if any. */
async function receipt(clientMessageId: string) {
  const itemId = agentJournalItemKey(reviewReplyReceiptIdentity(clientMessageId))
  const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
  const line = (await host.journalSnapshot(SESSION)).items.find((item) => item.itemId === itemId)
  return { written: journal?.itemWritten(itemId) ?? false, line: line?.body }
}

async function receiptItem(clientMessageId: string) {
  const itemId = agentJournalItemKey(reviewReplyReceiptIdentity(clientMessageId))
  return (await host.journalSnapshot(SESSION)).items.find((item) => item.itemId === itemId)
}

async function settledReceipt(clientMessageId: string) {
  await eventually(async () => expect((await receipt(clientMessageId)).written).toBe(true))
  return receipt(clientMessageId)
}

/** The next start waits for the test. */
function heldStart(): { release: () => void } {
  const held = Promise.withResolvers<void>()
  beforeSpawn.mockImplementationOnce(() => held.promise)
  return { release: () => held.resolve() }
}

function notInstalled(): AgentSessionPreSpawnError {
  return new AgentSessionPreSpawnError(new Error('codex not installed'), {
    reason: 'providerMissing',
    needsUser: true
  })
}

function retry(clientMessageId: string) {
  return host.retryMessage(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: fence(),
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.retryMessage',
        sessionId: SESSION,
        fields: { clientMessageId }
      })
    },
    clientMessageId
  })
}

describe('a launch prompt with a review reply', () => {
  it('writes nothing while the agent has not taken it, then everything once when it does', async () => {
    const id = await launchPrompt()
    await handedOver(id)
    await settled()
    expect(writes()).toBe(0)

    await accept(id)

    await settledReceipt(id)
    expect(review.resolveRepoReviewThread).toHaveBeenCalledExactlyOnceWith(
      'id:repo-1',
      'thread-resolvable',
      true,
      GITHUB.prRepo
    )
    expect(review.addRepoPRReviewCommentReply).toHaveBeenCalledExactlyOnceWith('id:repo-1', {
      prNumber: 42,
      commentId: 7,
      body: FIXING,
      threadId: 'thread-7',
      path: 'src/a.ts',
      line: 3,
      prRepo: GITHUB.prRepo
    })
    expect(review.addRepoIssueComment).toHaveBeenCalledExactlyOnceWith(
      'id:repo-1',
      42,
      'Fixing the review summary.',
      GITHUB.prRepo
    )
    // A live accept needs no read of the PR, and all going through shows nothing in the chat.
    expect(review.getRepoReviewReplyPosts).not.toHaveBeenCalled()
    expect((await receipt(id)).line).toBeUndefined()
    // The checks panel refetches the PR, as after its own writes.
    expect(review.reviewWritten).toHaveBeenCalledExactlyOnceWith('id:repo-1', 42)

    // Later commits re-derive nothing.
    await launchPrompt({ provider: 'gitlab', repoId: 'repo-1', iid: 1, resolve: [] })
    await settled()
    expect(writes()).toBe(3)
  })

  it('writes nothing for a message whose start failed for good, and runs once its Retry is taken', async () => {
    beforeSpawn.mockRejectedValueOnce(notInstalled())
    const id = await launchPrompt()
    await eventually(async () => expect((await submission(id))?.dispatchState).toBe('rejected'))
    await settled()
    expect(writes()).toBe(0)

    await expect(retry(id)).resolves.toMatchObject({ ok: true })
    await handedOver(id)
    expect(writes()).toBe(0)
    await accept(id)

    await settledReceipt(id)
    expect(writes()).toBe(3)
  })

  it('writes nothing for a message a Stop withdrew, or one the chat closed on', async () => {
    const start = heldStart()
    const stopped = await launchPrompt()
    const stop = host.cancel(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: fence(),
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.cancel',
          sessionId: SESSION,
          fields: {}
        })
      }
    })
    start.release()
    await stop
    await eventually(async () =>
      expect((await submission(stopped))?.dispatchState).toBe('rejected')
    )

    await host.close(SESSION, 'evict')
    const closing = heldStart()
    const closed = await launchPrompt()
    const close = host.close(SESSION, 'user-close')
    closing.release()
    await close
    await host.journalSnapshot(SESSION)
    await eventually(async () => expect((await submission(closed))?.dispatchState).toBe('rejected'))
    await settled()
    expect(writes()).toBe(0)
  })

  it('says why on its own line, once, when a write fails, and a reopen changes nothing', async () => {
    review.addRepoPRReviewCommentReply.mockResolvedValueOnce({ ok: false, error: 'HTTP 401' })
    const id = await launchPrompt()
    await handedOver(id)
    // The agent's turn is running when the writes fail, as it is once the agent took the message.
    const journal = host.collaboratorsForTests().sessions.get(SESSION)?.journal
    await journal?.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'turn-1', ordinal: 999 },
      { kind: 'turn', turnId: 'turn-1', state: 'running', startedAt: 1 },
      { fence: fence(), turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await accept(id)

    const { line } = await settledReceipt(id)
    expect(line).toMatchObject({
      kind: 'status',
      text: "Orca couldn't mark the review comments sent with this message as being fixed. Resolve or reply to them yourself.",
      failure: { kind: 'reviewReplyFailed', detail: { text: 'HTTP 401', audience: 'log' } },
      // Shown as a failure, and outside the agent's turn, so the turn folding never hides it.
      tone: 'error'
    })
    expect((await receiptItem(id))?.turnScope).toEqual({ kind: 'thread' })
    // The rest still went through.
    expect(writes()).toBe(3)

    await host.flushAllStreamedEvents()
    startHost()
    await host.journalSnapshot(SESSION)
    await settled()
    expect(writes()).toBe(3)
  })

  it('resolves GitLab discussions, and posts nothing', async () => {
    const id = await launchPrompt({
      provider: 'gitlab',
      repoId: 'repo-2',
      iid: 8,
      resolve: ['discussion-1', 'discussion-2']
    })
    await handedOver(id)
    await accept(id)

    await settledReceipt(id)
    expect(review.resolveGitLabRepoMRDiscussion.mock.calls).toEqual([
      ['id:repo-2', 8, 'discussion-1', true],
      ['id:repo-2', 8, 'discussion-2', true]
    ])
    expect(writes()).toBe(2)
    expect(review.reviewWritten).not.toHaveBeenCalled()
  })

  it('tells no PR view to refetch when nothing was written', async () => {
    review.resolveRepoReviewThread.mockResolvedValue(false)
    review.addRepoPRReviewCommentReply.mockResolvedValue({ ok: false, error: 'HTTP 401' })
    review.addRepoIssueComment.mockResolvedValue({ ok: false, error: 'HTTP 401' })
    const id = await launchPrompt()
    await handedOver(id)
    await accept(id)

    await settledReceipt(id)
    expect(writes()).toBe(3)
    expect(review.reviewWritten).not.toHaveBeenCalled()
  })
})

describe("a review reply's receipt", () => {
  it("is written in the chat's own lane, after the work already in it", async () => {
    const writesDone = Promise.withResolvers<void>()
    review.addRepoIssueComment.mockImplementationOnce(async () => {
      await writesDone.promise
      return { ok: true, comment: postedComment('summary') }
    })
    const id = await launchPrompt()
    await handedOver(id)
    await accept(id)
    await eventually(() => expect(review.addRepoIssueComment).toHaveBeenCalled())
    const lane = Promise.withResolvers<void>()
    const occupied = host.collaboratorsForTests().serialize(SESSION, () => lane.promise)

    writesDone.resolve()
    await settled()
    expect((await receipt(id)).written).toBe(false)

    lane.resolve()
    await occupied
    await settledReceipt(id)
  })
})

describe('a review reply cut off by a restart', () => {
  /** Accepted, with Orca dying while the writes run: no receipt reaches the chat. */
  let acceptedAt = 0

  async function acceptedThenCrashed(): Promise<string> {
    review.addRepoIssueComment.mockImplementationOnce(() => new Promise(() => {}))
    const id = await launchPrompt()
    await handedOver(id)
    await accept(id)
    await eventually(() => expect(review.addRepoIssueComment).toHaveBeenCalled())
    acceptedAt = (await submission(id))?.resolvedAt ?? 0
    await host.flushAllStreamedEvents()
    startHost()
    review.resolveRepoReviewThread.mockClear()
    review.addRepoPRReviewCommentReply.mockClear()
    review.addRepoIssueComment.mockClear()
    return id
  }

  /** A post on thread-7 by `author`, `secondsAfter` the agent took the message. */
  function onThread(author: string, secondsAfter: number): ReviewReplyPosts['threads'] {
    const at = new Date(acceptedAt + secondsAfter * 1000).toISOString()
    return { 'thread-7': [{ author, body: FIXING, createdAt: at }] }
  }

  it('posts only what the PR does not show yet, once the chat opens again', async () => {
    const id = await acceptedThenCrashed()
    onPR = { viewerLogin: 'me', threads: onThread('me', 1), conversation: [] }

    await host.journalSnapshot(SESSION)

    await settledReceipt(id)
    expect(review.getRepoReviewReplyPosts).toHaveBeenCalledExactlyOnceWith('id:repo-1', {
      prNumber: 42,
      prRepo: GITHUB.prRepo,
      threadIds: ['thread-7'],
      since: new Date(acceptedAt - REVIEW_REPLY_CLOCK_MARGIN_MS).toISOString()
    })
    expect(review.addRepoPRReviewCommentReply).not.toHaveBeenCalled()
    expect(review.addRepoIssueComment).toHaveBeenCalledOnce()
    expect(review.resolveRepoReviewThread).toHaveBeenCalledOnce()
  })

  it("counts this account's post from a host clock running ahead of GitHub's", async () => {
    const id = await acceptedThenCrashed()
    onPR = { viewerLogin: 'me', threads: onThread('me', -30), conversation: [] }

    await host.journalSnapshot(SESSION)

    await settledReceipt(id)
    expect(review.addRepoPRReviewCommentReply).not.toHaveBeenCalled()
  })

  it('replies where only another account posted the same words since', async () => {
    const id = await acceptedThenCrashed()
    onPR = { viewerLogin: 'me', threads: onThread('teammate', 1), conversation: [] }

    await host.journalSnapshot(SESSION)

    await settledReceipt(id)
    expect(review.addRepoPRReviewCommentReply).toHaveBeenCalledOnce()
  })

  it("matches the words alone when GitHub doesn't say which account it is", async () => {
    const id = await acceptedThenCrashed()
    onPR = { viewerLogin: null, threads: onThread('teammate', 1), conversation: [] }

    await host.journalSnapshot(SESSION)

    await settledReceipt(id)
    expect(review.addRepoPRReviewCommentReply).not.toHaveBeenCalled()
    expect(review.addRepoIssueComment).toHaveBeenCalledOnce()
  })

  it('posts everything once more when the read fails, and says so', async () => {
    const id = await acceptedThenCrashed()
    review.getRepoReviewReplyPosts.mockRejectedValueOnce(new Error('HTTP 502'))

    await host.journalSnapshot(SESSION)

    await settledReceipt(id)
    expect(review.addRepoPRReviewCommentReply).toHaveBeenCalledOnce()
    expect(review.addRepoIssueComment).toHaveBeenCalledOnce()
    expect(warnings).toContain(
      'review reply: could not read the PR before replying; a reply may repeat'
    )
  })

  it('posts nothing once the window since the agent took it has passed', async () => {
    await acceptedThenCrashed()
    // The journal stamps its rows, and reads the window, on the wall clock.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + REVIEW_REPLY_WINDOW_MS + 1)
    try {
      await host.journalSnapshot(SESSION)
      await settled()

      expect(writes()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('what a send may carry', () => {
  it('is recorded as a message, never held as a draft, while the agent works', async () => {
    const working = await launchPrompt({
      provider: 'gitlab',
      repoId: 'repo-1',
      iid: 1,
      resolve: []
    })
    await handedOver(working)
    const params = sendParams('resolve these too', GITHUB, hostTestOperationId())
    const fields = { body: params.body, delivery: 'queue-if-active', reviewReply: GITHUB }
    const sent = await host.send(CALLER, {
      ...params,
      envelope: {
        ...params.envelope,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.send',
          sessionId: SESSION,
          fields
        })
      },
      delivery: 'queue-if-active'
    })

    expect(sent).toMatchObject({ ok: true, value: { submission: { dispatchState: 'pending' } } })
  })

  it('is part of the send: the same id with another review reply is refused', async () => {
    const operation = hostTestOperationId()
    await expect(host.send(CALLER, sendParams('x', GITHUB, operation))).resolves.toMatchObject({
      ok: true
    })
    const other = { ...GITHUB, resolve: ['another-thread'] }
    await expect(host.send(CALLER, sendParams('x', other, operation))).resolves.toMatchObject({
      ok: false
    })
  })
})

describe('who learns a host runs review replies', () => {
  it('is every client: the host says so, so a client attaches one only where it runs', () => {
    expect(RUNTIME_CAPABILITIES).toContain(AGENT_SESSION_REVIEW_REPLY_RUNTIME_CAPABILITY)
  })
})
