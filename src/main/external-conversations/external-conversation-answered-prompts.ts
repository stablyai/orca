import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionPromptQuestions } from '../../shared/agent-session/requests/prompts/agent-session-question-answer'
import type { ConversationEvent, ConversationSnapshot } from './external-conversation-events'

type ShownPrompt = Extract<ConversationEvent, { kind: 'prompt' }>

function answeredWith(item: AgentJournalRenderItem | null): string | undefined {
  const body = item?.body
  if (
    !body ||
    (body.kind !== 'approval' && body.kind !== 'question') ||
    body.resolution.state !== 'resolved'
  ) {
    return undefined
  }
  const resolution = body.resolution
  let labels: string[]
  if (body.kind === 'approval') {
    labels = body.options
      .filter((option) => option.id === resolution.selectedOptionId)
      .map((option) => option.label)
  } else {
    const answers = resolution.answers
    if (!answers || answers.some((answer) => answer.other !== undefined)) {
      return undefined
    }
    const questions = agentSessionPromptQuestions(body)
    labels = answers.flatMap(
      (answer) =>
        questions
          .find((question) => question.id === answer.questionId)
          ?.options.filter((option) => answer.optionIds.includes(option.id))
          .map((option) => option.label) ?? []
    )
  }
  return labels.join(', ').slice(0, 80) || undefined
}

/** Prompts told to the cloud, by pane, until the agent works past one: someone answered it in Orca. */
export class AnsweredPrompts {
  private readonly shown = new Map<string, ShownPrompt>()
  private generation = 0

  constructor(
    private readonly deps: {
      /** The pane's turn is working again, as the watch's snapshot judges it. */
      working: (paneKey: string) => boolean
      emit: (event: ConversationEvent) => void
      resolvedPrompt?: (
        sessionId: string,
        itemId: string
      ) => AgentJournalRenderItem | null | Promise<AgentJournalRenderItem | null>
    }
  ) {}

  /**
   * Every prompt the watch tells, live or in a snapshot. One a turn end already dropped needs no
   * forgetting: the cloud closed its card then, so a later answered report changes nothing.
   */
  saw(event: ConversationEvent | ConversationSnapshot): void {
    if (event.kind === 'snapshot') {
      for (const { conversation, worktreeId, paneKey, prompt } of event.conversations) {
        if (prompt) {
          this.shown.set(paneKey, { kind: 'prompt', conversation, worktreeId, paneKey, prompt })
        }
      }
    } else if (event.kind === 'prompt' && !event.answered) {
      this.shown.set(event.paneKey, event)
    }
  }

  /** A connector's own answer, which the cloud already knows of, so it is never told as answered in
   *  Orca. Returns how to keep it again if the answer didn't land. */
  answering(paneKey: string, promptId: string): () => void {
    const shown = this.shown.get(paneKey)
    if (shown?.prompt.promptId !== promptId) {
      return () => {}
    }
    this.shown.delete(paneKey)
    return () => {
      if (!this.shown.has(paneKey)) {
        this.shown.set(paneKey, shown)
      }
    }
  }

  settle(paneKey: string): void {
    const shown = this.shown.get(paneKey)
    if (shown && this.deps.working(paneKey)) {
      this.shown.delete(paneKey)
      const generation = this.generation
      const emit = (item: AgentJournalRenderItem | null) => {
        if (generation !== this.generation) {
          return
        }
        const label = answeredWith(item)
        this.deps.emit({ ...shown, answered: true, ...(label ? { answeredWith: label } : {}) })
      }
      if (shown.prompt.open && this.deps.resolvedPrompt) {
        void Promise.resolve(
          this.deps.resolvedPrompt(shown.prompt.open.sessionId, shown.prompt.promptId)
        )
          .catch(() => null)
          .then(emit)
      } else {
        emit(null)
      }
    }
  }

  clear(): void {
    this.generation += 1
    this.shown.clear()
  }
}
