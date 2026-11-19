// A restored prompt's answer waits for the resumed agent to ask the same thing again, then answers
// it once. Any other request, the turn's end or a timeout spends it, so the person sees the card.

import { createHash } from 'node:crypto'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionPromptResult
} from '../../../../shared/agent-session/agent-session-wire'
import type {
  AgentJournalItemBody,
  AgentJournalResolution
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { computeAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/agent-session-mutation-envelope'
import { restoredPromptOptionFor } from '../../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { RestoredPromptJournal } from './structured-agent-session-restored-prompts'
import type { StructuredAgentSessionTurnCompletionSubscriber } from '../observations/structured-agent-session-turn-completion-feed'
import type { AgentSessionPromptRequest } from '../operations/structured-agent-session-turns-prompt'
import type { StructuredAgentSessionCaller } from '../host/structured-agent-session-host-types'

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

export type RestoredAnswerHoldsDeps = {
  conversation: (sessionId: string) => Promise<{ journal: Pick<RestoredPromptJournal, 'reads'> }>
  conversationFence: (sessionId: string) => number | null
  respond: (
    caller: StructuredAgentSessionCaller,
    params: AgentSessionPromptRequest & { envelope: AgentSessionMutationEnvelope }
  ) => Promise<AgentSessionMutationResult<AgentSessionPromptResult>>
  subscribeTurnCompletions: (
    subscriber: StructuredAgentSessionTurnCompletionSubscriber
  ) => () => void
}

const hex16 = (parts: readonly unknown[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)

/** The live request's answer carrying the restored one's meaning; null when it has none. */
function reaskedAnswer(
  hold: Hold,
  body: PromptBody
): Pick<AgentSessionPromptRequest, 'optionId' | 'answers'> | null {
  if (body.kind === 'question') {
    return hold.resolution.answers ? { answers: hold.resolution.answers } : null
  }
  const selected = hold.resolution.selectedOptionId
  const optionId =
    hold.restored.kind === 'approval' && selected !== null
      ? restoredPromptOptionFor(hold.restored, selected, body)
      : null
  return optionId ? { optionId } : null
}

export class RestoredAnswerHolds {
  private readonly holds = new Map<string, Hold>()
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: RestoredAnswerHoldsDeps) {}

  arm(
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
      emit: (event) => this.onEvent(event),
      // A closed chat's agent is gone, and so is the request its answer waited for.
      onClosed: (closed) => this.drop(closed)
    })
  }

  drop(sessionId: string): void {
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
    } else if (event.type === 'prompt') {
      const { sessionId, promptId } = event.prompt
      const hold = this.holds.get(sessionId)
      if (hold) {
        this.drop(sessionId)
        void this.answerReasked(sessionId, promptId, hold).catch(() => {})
      }
    }
  }

  /** Only an identical request takes the answer; the first request spends it either way. */
  private async answerReasked(sessionId: string, itemId: string, hold: Hold): Promise<void> {
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
    const answer = reaskedAnswer(hold, body)
    if (!answer) {
      return
    }
    const request = {
      itemId: item.itemId,
      expectedRevision: item.revision,
      kind: body.kind,
      ...answer
    }
    await this.deps.respond(
      { callerKey: RESTORED_PROMPT_ANSWER_CALLER },
      {
        ...request,
        envelope: {
          sessionId,
          clientOperationId: `restored-answer:${hex16([sessionId, item.itemId])}`,
          expectedRuntimeFence: this.deps.conversationFence(sessionId),
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
}
