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
import {
  AGENT_EXIT_PROMPT_ENDING,
  isAgentExitPromptBody,
  restoredAgentJournalPrompt,
  restoredPromptContinuationMessage
} from '../../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
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

export type StructuredAgentSessionRestoredPromptsDeps = {
  /** Opens the chat at rest; never starts its agent. */
  conversation: (sessionId: string) => Promise<{ journal: AgentSessionJournal }>
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
      respond: deps.respond,
      subscribeTurnCompletions: deps.subscribeTurnCompletions
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
    const body = item?.body
    if (
      !item ||
      (body?.kind !== 'approval' && body?.kind !== 'question') ||
      body.resolution.endedBy !== AGENT_EXIT_PROMPT_ENDING
    ) {
      return live()
    }
    const choice = readPromptChoice(body, params)
    if (!choice) {
      return invalid('optionRejected', `The answer does not fit item ${params.itemId}.`)
    }
    // A retry after a lost reply: the recorded answer stands.
    if (body.resolution.state === 'resolved') {
      return body.resolution.selectedOptionId === choice.selectedOptionId
        ? this.accepted(sessionId, journal, item.itemId, item.revision, body.resolution, true)
        : invalid('promptGone', `Item ${params.itemId} was already answered.`)
    }
    const { items } = await journal.reads.generation()
    const restored = restoredAgentJournalPrompt(items)
    if (restored?.itemId !== item.itemId || !isAgentExitPromptBody(body) || !body.requestDigest) {
      return invalid('promptGone', `Item ${params.itemId} can no longer be answered.`)
    }
    // Stop has no meaning for an agent that isn't running; only allow and deny carry over.
    if (
      body.kind === 'approval' &&
      !body.options.some((option) => option.id === choice.selectedOptionId && option.intent)
    ) {
      return invalid('optionRejected', `Option ${choice.selectedOptionId} can't be restored.`)
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
    journal: AgentSessionJournal,
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
    const deps = {
      ...continuationDeps(host, async () => true),
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
        // A start that fails after the answer is recorded is reported by the chat's own note.
        void started.verdict().then(
          (outcome) => outcome.outcome === 'refused' && this.holds.drop(sessionId),
          () => this.holds.drop(sessionId)
        )
      } else if (started.done.outcome === 'refused') {
        this.holds.drop(sessionId)
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
        this.holds.drop(sessionId)
        throw error
      }
    }
    const item = await journal.reads.item(params.itemId)
    const now = item?.body.kind === body.kind ? item.body.resolution : null
    if (!item || !now || now.state !== 'resolved') {
      return invalid('promptGone', `Item ${params.itemId} can no longer be answered.`)
    }
    return this.accepted(
      sessionId,
      journal,
      item.itemId,
      item.revision,
      now,
      committed.revision === undefined
    )
  }

  private async accepted(
    sessionId: string,
    journal: AgentSessionJournal,
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
