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
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import {
  AGENT_EXIT_PROMPT_ENDING,
  isAgentExitPromptBody,
  restoredAgentJournalPrompt,
  restoredPromptContinuationMessage,
  restoredPromptOptionFor
} from '../../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { StructuredAgentSessionTurnCompletionSubscriber } from '../observations/structured-agent-session-turn-completion-feed'
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

/** The answer waits this long for the resumed agent to ask again; after that it asks the person. */
export const RESTORED_ANSWER_HOLD_MS = 10 * 60_000

export const RESTORED_PROMPT_ANSWER_CALLER = 'trusted-local:restored-prompt-answer'

type Hold = {
  digest: string
  restored: PromptBody
  resolution: AgentJournalResolution
  timer: ReturnType<typeof setTimeout>
}

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
  resolvedBy: (caller: StructuredAgentSessionCaller) => string | null
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
  private readonly holds = new Map<string, Hold>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: StructuredAgentSessionRestoredPromptsDeps) {}

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
      resolvedBy: this.deps.resolvedBy(caller),
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
      this.arm(sessionId, digest, body, resolution)
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
          (outcome) => outcome.outcome === 'refused' && this.drop(sessionId),
          () => this.drop(sessionId)
        )
      } else if (started.done.outcome === 'refused') {
        this.drop(sessionId)
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
        this.drop(sessionId)
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

  private arm(
    sessionId: string,
    digest: string,
    restored: PromptBody,
    resolution: AgentJournalResolution
  ): void {
    this.drop(sessionId)
    const timer = setTimeout(() => this.drop(sessionId), RESTORED_ANSWER_HOLD_MS)
    timer.unref?.()
    this.holds.set(sessionId, { digest, restored, resolution, timer })
    // Listens only while an answer waits, so idle chats cost nothing.
    this.unsubscribe ??= this.deps.subscribeTurnCompletions({
      id: RESTORED_PROMPT_ANSWER_CALLER,
      includePrompts: true,
      emit: (event) => this.onEvent(event)
    })
  }

  private drop(sessionId: string): void {
    const hold = this.holds.get(sessionId)
    if (hold) {
      clearTimeout(hold.timer)
      this.holds.delete(sessionId)
    }
    if (this.holds.size === 0 && this.unsubscribe) {
      const unsubscribe = this.unsubscribe
      this.unsubscribe = null
      unsubscribe()
    }
  }

  private onEvent(event: AgentSessionTurnCompletionEvent): void {
    if (event.type === 'completion') {
      // The turn ended without asking again: the answer is spent.
      this.drop(event.completion.sessionId)
    } else if (event.type === 'prompt' && this.holds.has(event.prompt.sessionId)) {
      void this.answerReasked(event.prompt.sessionId, event.prompt.promptId).catch(() => {
        this.drop(event.prompt.sessionId)
      })
    }
  }

  /** The first request after resume takes the answer only when it is the same request; either way
   *  the answer is spent, so a different request always reaches the person. */
  private async answerReasked(sessionId: string, itemId: string): Promise<void> {
    const hold = this.holds.get(sessionId)
    if (!hold) {
      return
    }
    this.drop(sessionId)
    const { journal } = await this.deps.conversation(sessionId)
    const item = await journal.reads.item(itemId)
    const body = item?.body
    if (
      !item ||
      (body?.kind !== 'approval' && body?.kind !== 'question') ||
      body.kind !== hold.restored.kind ||
      body.resolution.state !== 'pending' ||
      body.requestDigest !== hold.digest
    ) {
      return
    }
    const fields =
      body.kind === 'approval'
        ? {
            optionId:
              hold.resolution.selectedOptionId === null
                ? null
                : restoredPromptOptionFor(
                    hold.restored as Extract<PromptBody, { kind: 'approval' }>,
                    hold.resolution.selectedOptionId,
                    body
                  )
          }
        : { answers: hold.resolution.answers ?? null }
    if (fields.optionId === null || ('answers' in fields && fields.answers === null)) {
      return
    }
    const request = {
      itemId: item.itemId,
      expectedRevision: item.revision,
      kind: body.kind,
      ...(fields.optionId ? { optionId: fields.optionId } : {}),
      ...('answers' in fields && fields.answers ? { answers: fields.answers } : {})
    }
    const fence = this.deps.continuationHost().conversationFence(sessionId)
    await this.deps.respond(
      { callerKey: RESTORED_PROMPT_ANSWER_CALLER },
      {
        ...request,
        envelope: {
          sessionId,
          clientOperationId: `restored-answer:${hex16([sessionId, item.itemId])}`,
          expectedRuntimeFence: fence,
          payloadFingerprint: computeAgentSessionPayloadFingerprint({
            method: `agentSession.respondTo:${body.kind}`,
            sessionId,
            fields: {
              itemId: request.itemId,
              expectedRevision: request.expectedRevision,
              optionId: request.optionId,
              answers: request.answers
            }
          })
        }
      }
    )
  }

  dispose(): void {
    for (const sessionId of [...this.holds.keys()]) {
      this.drop(sessionId)
    }
  }
}
