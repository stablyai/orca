// Re-send a start the agent refused for want of a login: on Retry, and once on its own after sign-in.

import { createHash } from 'node:crypto'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionExecutionOptionsRecord } from '../../../../shared/agent-session/options/agent-session-execution-options'
import { structuredAgentSessionMessageSendMutation } from '../../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import {
  latestNativeChatSignedOutSend,
  nativeChatSignedOutSendCard
} from '../../../../shared/native-chat/native-chat-signed-out-retry'
import type { StructuredAgentSessionMutationContext } from '../operations/structured-agent-session-mutation-context'
import type { StructuredAgentSessionHost } from '../host/structured-agent-session-host'
import { RestartContinuationSupersededError } from './structured-agent-session-restart-continuation'

/** Past this, a refused prompt waits for a person's Retry: it may no longer be wanted. */
const AUTOMATIC_RETRY_WINDOW_MS = 30 * 60_000
const CALLER = { callerKey: 'trusted-local:signed-out-retry' }

export type StructuredAgentSessionSignedOutRetryOutcome = {
  outcome: 'sent' | 'superseded' | 'refused'
  reason?: string
}

const refusedAt = (send: AgentJournalSubmission): number => send.resolvedAt ?? send.submittedAt

/** One id per refused send, so Retry and the automatic retry replay each other's send. */
function retryId(sessionId: string, refused: AgentJournalSubmission): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(['signed-out-retry', sessionId, refused.clientMessageId]))
    .digest('hex')
    .slice(0, 32)
  return `${Math.trunc(refusedAt(refused)).toString().padStart(13, '0')}-${digest}`
}

/** A retry refused again is left to the person, so each refusal is retried on its own once. */
function isRetry(
  sessionId: string,
  send: AgentJournalSubmission,
  submissions: readonly AgentJournalSubmission[]
): boolean {
  const at = send.clientMessageId.slice(0, 13)
  return submissions.some(
    (earlier) =>
      earlier !== send &&
      Math.trunc(refusedAt(earlier)).toString().padStart(13, '0') === at &&
      retryId(sessionId, earlier) === send.clientMessageId
  )
}

export class StructuredAgentSessionSignedOutRetry {
  private readonly attempted = new Set<string>()
  private running: Promise<void> | null = null
  private again = false
  private disposed = false
  private stop: (() => void) | undefined

  constructor(
    private readonly context: Pick<StructuredAgentSessionMutationContext, 'deps' | 'sessions'>,
    private readonly host: Pick<StructuredAgentSessionHost, 'send' | 'queuedMessageSend'>,
    private readonly now: () => number
  ) {}

  start(): void {
    this.stop = this.context.deps.signedOutRetry?.subscribe(() => void this.sweep())
  }

  dispose(): void {
    this.disposed = true
    this.stop?.()
    this.attempted.clear()
  }

  retry = async (
    sessionId: string,
    clientMessageId: string
  ): Promise<StructuredAgentSessionSignedOutRetryOutcome> => {
    const refused = this.refused(sessionId)
    return refused?.clientMessageId === clientMessageId
      ? this.send(sessionId, refused)
      : { outcome: 'superseded' }
  }

  /** Coalesced: account changes arrive in bursts, and each pass reads every loaded chat. */
  sweep(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.pass().catch((error: unknown) =>
          this.context.deps.logger.warn('signed-out retry sweep failed', {
            scope: 'signed-out-retry',
            error
          })
        )
      } while (this.again)
    })().finally(() => {
      this.running = null
    })
    return this.running
  }

  private async pass(): Promise<void> {
    const { deps } = this.context
    // The launch account depends on the agent and where it runs; one read per pass serves both.
    const signedIn = new Map<string, Promise<boolean>>()
    for (const [sessionId, session] of this.context.sessions) {
      const submissions = session.journal.submissions()
      const refused = latestNativeChatSignedOutSend(submissions)
      const record = deps.store.getRecord(sessionId)
      const card = refused && nativeChatSignedOutSendCard(refused)
      if (
        this.disposed ||
        !refused ||
        !record ||
        record.location.executionHostId !== deps.store.hostId ||
        this.attempted.has(refused.clientMessageId) ||
        this.now() - refusedAt(refused) > AUTOMATIC_RETRY_WINDOW_MS ||
        isRetry(sessionId, refused, submissions) ||
        (card && session.journal.queuedMessages.editLeases.isHeld(card))
      ) {
        continue
      }
      const key = JSON.stringify([record.provider, record.location.wslDistro ?? null])
      if (!signedIn.has(key)) {
        signedIn.set(
          key,
          deps.signedOutRetry?.launchAccountSignedIn(record).catch(() => false) ??
            Promise.resolve(false)
        )
      }
      if (!(await signedIn.get(key)) || this.disposed) {
        continue
      }
      this.attempted.add(refused.clientMessageId)
      await this.send(sessionId, refused, true).catch((error: unknown) =>
        deps.logger.warn('automatic signed-out retry failed', {
          scope: 'signed-out-retry',
          sessionId,
          error
        })
      )
    }
  }

  private refused(sessionId: string): AgentJournalSubmission | null {
    const journal = this.context.sessions.get(sessionId)?.journal
    return journal ? latestNativeChatSignedOutSend(journal.submissions()) : null
  }

  private async send(
    sessionId: string,
    refused: AgentJournalSubmission,
    automatic = false
  ): Promise<StructuredAgentSessionSignedOutRetryOutcome> {
    const journal = this.context.sessions.get(sessionId)?.journal
    const body = journal?.submissionBody(refused.clientMessageId)
    const record = this.context.deps.store.getRecord(sessionId)
    if (!journal || !body || !record || this.disposed) {
      return { outcome: 'refused', reason: 'agent_session_not_attached' }
    }
    const clientOperationId = retryId(sessionId, refused)
    const card = nativeChatSignedOutSendCard(refused)
    // Under the session lock: a newer send, or the other retry, has already moved the chat on, and
    // a person editing the card sends it themselves.
    const beforeRun = () => {
      if (
        this.disposed ||
        this.refused(sessionId)?.clientMessageId !== refused.clientMessageId ||
        (automatic && card !== null && journal.queuedMessages.editLeases.isHeld(card))
      ) {
        throw new RestartContinuationSupersededError()
      }
    }
    const envelope = {
      sessionId,
      clientOperationId,
      expectedRuntimeFence: record.lease.runtimeFence
    }
    try {
      // The card's own Send: it hands over once, so a person's Send and this one cannot both land.
      const sent =
        card !== null
          ? await this.host.queuedMessageSend(CALLER, {
              envelope: {
                ...envelope,
                payloadFingerprint: structuredAgentSessionPayloadFingerprint({
                  method: 'agentSession.queuedMessageSend',
                  sessionId,
                  fields: { messageId: card }
                })
              },
              messageId: card,
              beforeRun
            })
          : await this.host.send(CALLER, {
              ...structuredAgentSessionMessageSendMutation({
                ...envelope,
                body,
                ...(refused.options
                  ? { options: agentSessionExecutionOptionsRecord(refused.options) }
                  : {})
              }),
              ...(refused.source?.kind === 'user' ? { personsMessage: true as const } : {}),
              beforeRun
            })
      return sent.ok
        ? { outcome: 'sent' }
        : { outcome: 'refused', reason: sent.refusal?.code ?? 'agent_session_send_failed' }
    } catch (error) {
      if (error instanceof RestartContinuationSupersededError) {
        return { outcome: 'superseded' }
      }
      throw error
    }
  }
}
