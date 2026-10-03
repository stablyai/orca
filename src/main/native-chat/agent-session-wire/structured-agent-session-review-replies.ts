// A launch prompt's review reply runs once the agent takes the message. What is owed is derived,
// never stored: a message carrying a review reply, accepted within the window, whose chat has no
// receipt for it. The receipt is an item in the chat under the message's own id: a status line when
// a write failed, a tombstone (nothing shown) when all went through.

import {
  AGENT_SESSION_REVIEW_REPLY_WINDOW_MS,
  agentSessionReviewReplyReceiptMessageId,
  type AgentSessionReviewReply
} from '../../../shared/agent-session-review-reply'
import { agentSessionFailureFact, providerDiagnostic } from '../../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { runStructuredAgentSessionReviewReply } from './structured-agent-session-review-reply-runner'

export const REVIEW_REPLY_WINDOW_MS = AGENT_SESSION_REVIEW_REPLY_WINDOW_MS

export function reviewReplyReceiptIdentity(clientMessageId: string): AgentJournalItemIdentity {
  return {
    provider: 'orca',
    clientMessageId: agentSessionReviewReplyReceiptMessageId(clientMessageId)
  }
}

/** The receipt: the failure said once on its own line, or a tombstone that shows nothing. */
export async function writeStructuredAgentSessionReviewReplyReceipt(
  journal: AgentSessionJournal,
  fence: number,
  clientMessageId: string,
  failure: string | null
): Promise<void> {
  const identity = reviewReplyReceiptIdentity(clientMessageId)
  if (failure === null) {
    await journal.appendTombstone(identity, { fence })
    return
  }
  const detail = providerDiagnostic(failure, 'log')
  await journal.appendItem(
    identity,
    {
      kind: 'status',
      ...agentSessionFailureWords(
        agentSessionFailureFact('reviewReplyFailed', detail ? { detail } : {}),
        { surface: 'row' }
      ),
      tone: 'error'
    },
    // About the review, not the agent's turn: a turn's rows fold once it ends, and the agent's
    // answer would fold this line with them.
    { fence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
}

export type StructuredAgentSessionReviewRepliesDeps = {
  /** The writes; answers the first failure's words, or null when all went through. */
  run: (
    spec: AgentSessionReviewReply,
    options: { acceptedAt: number; reread: boolean }
  ) => Promise<string | null>
  /** Records the receipt in the chat; null `failure` hides it. */
  writeReceipt: (
    sessionId: string,
    clientMessageId: string,
    failure: string | null
  ) => Promise<void>
  log: (message: string, error: unknown) => void
}

export class StructuredAgentSessionReviewReplies {
  /** Runs in flight or done in this process: a cache over the derived rule, never its truth. */
  private readonly claimed = new Set<string>()
  /** Messages seen waiting for the agent in this process: their run follows a live accept. */
  private readonly seenWaiting = new Set<string>()

  constructor(private readonly deps: StructuredAgentSessionReviewRepliesDeps) {}

  /** Called on every journal publish and once as a journal opens. */
  observe(sessionId: string, journal: AgentSessionJournal): void {
    for (const [clientMessageId, spec] of journal.reviewReplies()) {
      const key = `${sessionId}:${clientMessageId}`
      const submission = journal.submission(clientMessageId)
      if (!submission || this.claimed.has(key)) {
        continue
      }
      if (submission.dispatchState !== 'accepted') {
        if (submission.dispatchState === 'pending' || submission.dispatchState === 'unknown') {
          this.seenWaiting.add(key)
        }
        continue
      }
      const acceptedAt = submission.resolvedAt
      if (
        acceptedAt === null ||
        journal.clock() - acceptedAt > REVIEW_REPLY_WINDOW_MS ||
        journal.itemWritten(agentJournalItemKey(reviewReplyReceiptIdentity(clientMessageId)))
      ) {
        continue
      }
      this.claimed.add(key)
      // Accepted before this process saw it wait: an earlier run may have posted before its receipt.
      const reread = !this.seenWaiting.delete(key)
      void this.settle(sessionId, clientMessageId, spec, { acceptedAt, reread })
    }
  }

  private async settle(
    sessionId: string,
    clientMessageId: string,
    spec: AgentSessionReviewReply,
    options: { acceptedAt: number; reread: boolean }
  ): Promise<void> {
    let failure: string | null
    try {
      failure = await this.deps.run(spec, options)
    } catch (error) {
      this.deps.log('review reply: the run failed', error)
      failure = error instanceof Error ? error.message : String(error)
    }
    // A receipt the chat refuses (closed, read-only) is logged. This process keeps its claim, so the
    // reply is derived again only after Orca restarts, inside the window, re-reading the PR first.
    await this.deps
      .writeReceipt(sessionId, clientMessageId, failure)
      .catch((error: unknown) => this.deps.log('review reply: the receipt was not written', error))
  }
}

/** The host's review replies: writes through its runtime; each receipt in the chat's own lane, at
 *  the fence it holds then, so no start or close moves the fence under the append. */
export function createStructuredAgentSessionHostReviewReplies(host: {
  deps: () => Pick<StructuredAgentSessionHostDeps, 'reviewRuntime' | 'store' | 'logger'>
  journal: (sessionId: string) => AgentSessionJournal | undefined
  serialize: <T>(sessionId: string, task: () => Promise<T>) => Promise<T>
}): { observe: (sessionId: string) => void } {
  const log = (message: string, error: unknown): void =>
    host.deps().logger.warn(message, { scope: 'review-reply', error })
  const replies = new StructuredAgentSessionReviewReplies({
    run: async (spec, options) => {
      const runtime = host.deps().reviewRuntime
      if (!runtime) {
        throw new Error('This host cannot write to the review.')
      }
      return runStructuredAgentSessionReviewReply(runtime, spec, { ...options, log })
    },
    // Queued behind the lane's work, never awaited from inside it: the run was started off a
    // publish, so a task in the lane never waits on this.
    writeReceipt: (sessionId, clientMessageId, failure) =>
      host.serialize(sessionId, async () => {
        const journal = host.journal(sessionId)
        if (!journal) {
          throw new Error(`chat ${sessionId} is closed`)
        }
        const fence = structuredAgentSessionConversationFence(host.deps().store, sessionId)
        await writeStructuredAgentSessionReviewReplyReceipt(
          journal,
          fence,
          clientMessageId,
          failure
        )
      }),
    log
  })
  return {
    // A host with no review surface owes nothing, so it never writes a receipt either.
    observe: (sessionId) => {
      const journal = host.journal(sessionId)
      if (journal && host.deps().reviewRuntime) {
        replies.observe(sessionId, journal)
      }
    }
  }
}
