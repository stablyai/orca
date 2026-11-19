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
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/agent-session/lifecycle/operations/structured-agent-session-mutation'
import { restoredPromptOptionFor } from '../../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'
import type { AgentSessionTurnCompletionEvent } from '../../../../shared/agent-session/view/agent-session-turn-completion-wire'
import type { RestoredPromptJournal } from './structured-agent-session-restored-prompts'
import type { StructuredAgentSessionTurnCompletionSubscriber } from '../observations/structured-agent-session-turn-completion-feed'
import type { AgentSessionPromptRequest } from '../operations/structured-agent-session-turns-prompt'
import type { StructuredAgentSessionCaller } from '../host/structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'

type PromptBody = Extract<AgentJournalItemBody, { kind: 'approval' | 'question' }>

/** The answer waits this long for the resumed agent to ask again; after that it asks the person. */
export const RESTORED_ANSWER_HOLD_MS = 10 * 60_000

export const RESTORED_PROMPT_ANSWER_CALLER = 'trusted-local:restored-prompt-answer'

type Hold = {
  digest: string
  /** Only what matching needs: a hold never keeps the request's text. */
  restored: Pick<PromptBody, 'kind' | 'options'>
  resolution: AgentJournalResolution
  timer: ReturnType<typeof setTimeout>
}

export type RestoredAnswerHoldsDeps = {
  conversation: (sessionId: string) => Promise<{ journal: Pick<RestoredPromptJournal, 'reads'> }>
  conversationFence: (sessionId: string) => number | null
  /** A child or a start in flight: the request the answer waits for can still come. */
  agentRunning: (sessionId: string) => boolean
  respond: (
    caller: StructuredAgentSessionCaller,
    params: AgentSessionPromptRequest & { envelope: AgentSessionMutationEnvelope }
  ) => Promise<AgentSessionMutationResult<AgentSessionPromptResult>>
  subscribeTurnCompletions: (
    subscriber: StructuredAgentSessionTurnCompletionSubscriber
  ) => () => void
  logger: () => StructuredAgentSessionLogger
  now: () => number
}

// Host authority accepts only `<13-digit ms>-<32 hex>` ids.
const operationId = (at: number, parts: readonly unknown[]): string =>
  `${String(Math.trunc(at)).padStart(13, '0')}-${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)}`

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
    this.holds.set(sessionId, {
      digest,
      restored: { kind: restored.kind, options: restored.options },
      resolution,
      timer
    })
    // Listens only while an answer waits, so idle chats cost nothing.
    this.unsubscribe ??= this.deps.subscribeTurnCompletions({
      id: RESTORED_PROMPT_ANSWER_CALLER,
      includePrompts: true,
      emit: (event) => this.onEvent(event),
      // A closed chat with no agent left can't ask again; a reattach while its agent starts can.
      onClosed: (closed) => {
        if (!this.deps.agentRunning(closed)) {
          this.drop(closed)
        }
      },
      // A chat reattached as its agent starts announces its first state here, without an edge.
      onState: ({ sessionId, pendingPromptIds }) => {
        if (pendingPromptIds.length === 1) {
          this.reasked(sessionId, pendingPromptIds[0]!)
        } else if (pendingPromptIds.length > 1) {
          // Which came first is unknown, so none is taken as the re-ask: the answer is spent.
          this.drop(sessionId)
        }
      }
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
      this.reasked(event.prompt.sessionId, event.prompt.promptId)
    }
  }

  private reasked(sessionId: string, promptId: string): void {
    const hold = this.holds.get(sessionId)
    if (hold) {
      this.drop(sessionId)
      void this.answerReasked(sessionId, promptId, hold).catch((error: unknown) =>
        this.deps.logger().warn('answering a re-asked restored prompt failed', {
          scope: 'restored-prompt-answer',
          sessionId,
          error
        })
      )
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
    const result = await this.deps.respond(
      { callerKey: RESTORED_PROMPT_ANSWER_CALLER },
      {
        ...request,
        envelope: {
          sessionId,
          clientOperationId: operationId(this.deps.now(), [sessionId, item.itemId]),
          expectedRuntimeFence: this.deps.conversationFence(sessionId),
          payloadFingerprint: structuredAgentSessionPayloadFingerprint({
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
    if (!result.ok) {
      this.deps.logger().warn('a re-asked restored prompt refused its stored answer', {
        scope: 'restored-prompt-answer',
        sessionId,
        code: result.refusal.code
      })
    }
  }
}
