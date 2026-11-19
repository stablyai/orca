// Answer a prompt whose agent exited waiting on it: record the answer, resume the agent with a
// message naming it, and answer the resumed agent's identical request once on the person's behalf.

import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionPromptResult
} from '../../../../shared/agent-session/agent-session-wire'
import type {
  AgentJournalItemBody,
  AgentJournalResolution
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { refuse } from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { AGENT_SESSION_RESTART_CONTINUATION_NOTE } from '../../../../shared/agent-session/lifecycle/stopping/agent-session-restart-continuation'
import {
  AGENT_EXIT_PROMPT_ENDING,
  restoredApprovalOptions,
  restoredPromptContinuationMessage
} from '../../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { JournalPromptMutationInput } from '../../agent-session-journal/journal-store-contracts'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { StructuredAgentSessionTurnCompletionSubscriber } from '../observations/structured-agent-session-turn-completion-feed'
import { RestoredAnswerHolds } from './structured-agent-session-restored-answer-holds'
import {
  readPromptChoice,
  type AgentSessionPromptRequest
} from '../operations/structured-agent-session-turns-prompt'
import type { StructuredAgentSessionCaller } from '../host/structured-agent-session-host-types'
import {
  continuationDeps,
  RestartContinuationSupersededError,
  startStructuredAgentSessionContinuation,
  type StructuredAgentSessionContinuationHost
} from './structured-agent-session-restart-continuation'

type PromptParams = AgentSessionPromptRequest & { envelope: AgentSessionMutationEnvelope }
type PromptResult = AgentSessionMutationResult<AgentSessionPromptResult>
type PromptBody = Extract<AgentJournalItemBody, { kind: 'approval' | 'question' }>

/** The reads and the one write a restored answer needs from the chat's journal. */
export type RestoredPromptJournal = {
  reads: Pick<AgentSessionJournal['reads'], 'item' | 'restoredPrompt'> & {
    cursor: () => Promise<AgentJournalCursor>
  }
  mutatePrompt: (input: JournalPromptMutationInput) => Promise<{ revision: number }>
}

export type StructuredAgentSessionRestoredPromptsDeps = {
  /** Opens the chat at rest; never starts its agent. */
  conversation: (sessionId: string) => Promise<{ journal: RestoredPromptJournal }>
  /** A child or a start in flight: its prompts are answered live. */
  agentRunning: (sessionId: string) => boolean
  continuationHost: () => Omit<StructuredAgentSessionContinuationHost, 'stillResumable'>
  respond: (caller: StructuredAgentSessionCaller, params: PromptParams) => Promise<PromptResult>
  subscribeTurnCompletions: (
    subscriber: StructuredAgentSessionTurnCompletionSubscriber
  ) => () => void
  now: () => number
}

function invalid(reason: 'promptGone' | 'optionRejected', message: string): PromptResult {
  return {
    ok: false,
    refusal: refuse('agent_session_operation_invalid', { reason }, message)
  }
}

const hex16 = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)

export class StructuredAgentSessionRestoredPrompts {
  private readonly holds: RestoredAnswerHolds

  constructor(private readonly deps: StructuredAgentSessionRestoredPromptsDeps) {
    this.holds = new RestoredAnswerHolds({
      conversation: deps.conversation,
      conversationFence: (sessionId) => deps.continuationHost().conversationFence(sessionId),
      agentRunning: deps.agentRunning,
      respond: deps.respond,
      subscribeTurnCompletions: deps.subscribeTurnCompletions,
      logger: () => deps.continuationHost().logger,
      now: deps.now
    })
  }

  /** Restored rows only; everything else, and every chat with a running agent, goes `live`. */
  async respond(
    caller: StructuredAgentSessionCaller,
    params: PromptParams,
    live: () => Promise<PromptResult>
  ): Promise<PromptResult> {
    const { sessionId } = params.envelope
    if (this.deps.agentRunning(sessionId)) {
      return live()
    }
    const { journal } = await this.deps.conversation(sessionId)
    const item = await journal.reads.item(params.itemId)
    const asked = item?.body
    if (
      !item ||
      (asked?.kind !== 'approval' && asked?.kind !== 'question') ||
      asked.resolution.endedBy !== AGENT_EXIT_PROMPT_ENDING
    ) {
      return live()
    }
    const body =
      asked.kind === 'approval'
        ? { ...asked, options: restoredApprovalOptions(asked.options) }
        : asked
    const choice = readPromptChoice(body, params)
    if (!choice) {
      return invalid('optionRejected', `The answer does not fit item ${params.itemId}.`)
    }
    // A retry after a lost reply: the recorded answer stands.
    if (body.resolution.state === 'resolved') {
      return this.recorded(sessionId, journal, params.itemId, choice.selectedOptionId)
    }
    if ((await journal.reads.restoredPrompt())?.itemId !== item.itemId || !body.requestDigest) {
      return invalid('promptGone', `Item ${params.itemId} can no longer be answered.`)
    }
    const resolution: AgentJournalResolution = {
      state: 'resolved',
      selectedOptionId: choice.selectedOptionId,
      ...(choice.response.kind === 'answers' ? { answers: choice.response.answers } : {}),
      resolvedBy: caller.callerKey,
      resolvedAt: this.deps.now(),
      endedBy: AGENT_EXIT_PROMPT_ENDING
    }
    return this.answerAndResume(journal, params, body, body.requestDigest, resolution, choice)
  }

  private async answerAndResume(
    journal: RestoredPromptJournal,
    params: PromptParams,
    body: PromptBody,
    digest: string,
    resolution: AgentJournalResolution,
    choice: NonNullable<ReturnType<typeof readPromptChoice>>
  ): Promise<PromptResult> {
    const { sessionId } = params.envelope
    const host = this.deps.continuationHost()
    const committed: { revision?: number } = {}
    const commit = async (): Promise<void> => {
      // Rechecked in the send's own lane: a message another device sent since ends the card.
      if ((await journal.reads.restoredPrompt())?.itemId !== params.itemId) {
        throw new RestartContinuationSupersededError()
      }
      // The answer is recorded before the agent hears of it; a second device's answer loses here.
      const written = await journal
        .mutatePrompt({
          itemId: params.itemId,
          expectedRevision: params.expectedRevision,
          kind: params.kind,
          resolution,
          restored: true,
          options: {
            fence: host.conversationFence(sessionId) ?? 0,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }
        })
        .catch(() => {
          throw new RestartContinuationSupersededError()
        })
      committed.revision = written.revision
      this.holds.arm(sessionId, digest, body, resolution)
    }
    const actionAt = host.now()
    const continuationId = `${Math.trunc(actionAt).toString().padStart(13, '0')}-${hex16([sessionId, params.itemId])}${hex16([sessionId, params.itemId, randomUUID()])}`
    const base = continuationDeps(host, async () => true)
    const deps = {
      ...base,
      // The answered card already says why the agent resumed; failure notes still land.
      note: (id: string, text: string, tone?: 'error' | 'warning') =>
        text === AGENT_SESSION_RESTART_CONTINUATION_NOTE
          ? Promise.resolve()
          : base.note(id, text, tone),
      answerAtAcceptance: true as const,
      send: (input: Parameters<typeof host.send>[0]) =>
        host.send({ ...input, continuation: true, beforeRun: commit })
    }
    const message = restoredPromptContinuationMessage(body, choice.response)
    try {
      const started = await startStructuredAgentSessionContinuation(
        deps,
        sessionId,
        { message },
        continuationId
      )
      if ('verdict' in started) {
        void started.verdict().then(
          async (outcome) => {
            if (outcome.outcome === 'refused') {
              await this.undo(journal, params, committed.revision)
            }
          },
          () => committed.revision !== undefined && this.holds.drop(sessionId)
        )
      } else if (started.done.outcome === 'refused') {
        await this.undo(journal, params, committed.revision)
        return {
          ok: false,
          refusal: refuse(
            'agent_session_operation_invalid',
            { reason: 'promptOwnerEnded' },
            started.done.reason ?? 'The chat could not be resumed.'
          )
        }
      }
    } catch (error) {
      if (!(error instanceof RestartContinuationSupersededError)) {
        await this.undo(journal, params, committed.revision)
        throw error
      }
    }
    return this.recorded(
      sessionId,
      journal,
      params.itemId,
      choice.selectedOptionId,
      committed.revision === undefined
    )
  }

  /** Success only for the answer the card holds now; another device's different answer wins. */
  private async recorded(
    sessionId: string,
    journal: RestoredPromptJournal,
    itemId: string,
    selectedOptionId: string,
    replayed = true
  ): Promise<PromptResult> {
    const item = await journal.reads.item(itemId)
    const body = item?.body
    if (!item || (body?.kind !== 'approval' && body?.kind !== 'question')) {
      return invalid('promptGone', `Item ${itemId} can no longer be answered.`)
    }
    const { resolution } = body
    if (resolution.state !== 'resolved' || resolution.selectedOptionId !== selectedOptionId) {
      return {
        ok: false,
        refusal: refuse(
          'agent_session_already_resolved',
          { reason: 'promptAlreadyResolved', currentRevision: item.revision, resolution },
          `Item ${itemId} was already ${resolution.state}.`
        )
      }
    }
    return this.accepted(sessionId, journal, item.itemId, item.revision, resolution, replayed)
  }

  /** The agent could not be started: an answer recorded for it never reached it, so the card
   *  asks again. */
  private async undo(
    journal: RestoredPromptJournal,
    params: PromptParams,
    revision: number | undefined
  ): Promise<void> {
    // Only the attempt that recorded the answer owns its hold; another attempt may have armed it.
    if (revision === undefined) {
      return
    }
    const { sessionId } = params.envelope
    this.holds.drop(sessionId)
    await journal
      .mutatePrompt({
        itemId: params.itemId,
        expectedRevision: revision,
        kind: params.kind,
        resolution: {
          state: 'cancelled',
          selectedOptionId: null,
          resolvedBy: null,
          resolvedAt: null,
          endedBy: AGENT_EXIT_PROMPT_ENDING
        },
        restored: true,
        options: {
          fence: this.deps.continuationHost().conversationFence(sessionId) ?? 0,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      })
      .catch(() => {})
  }

  private async accepted(
    sessionId: string,
    journal: RestoredPromptJournal,
    itemId: string,
    revision: number,
    resolution: AgentJournalResolution,
    replayed: boolean
  ): Promise<PromptResult> {
    return {
      ok: true,
      replayed,
      fence: this.deps.continuationHost().conversationFence(sessionId) ?? 0,
      cursor: await journal.reads.cursor(),
      value: { itemId, revision, resolution }
    }
  }
}
