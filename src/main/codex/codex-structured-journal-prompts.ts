import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  boundJournalPromptBody,
  cancelledJournalPromptBody
} from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
import {
  codexApprovalItem,
  codexPromptIdentity,
  codexQuestionItems
} from './codex-structured-prompt-items'
import { CODEX_USER_INPUT_METHOD } from './codex-structured-prompt-replies'
import type {
  CodexJournalTranslationAdmission,
  CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import { CODEX_JOURNAL_ADMITTED } from './codex-structured-journal-contracts'
import { MAX_CODEX_PENDING_PROMPTS } from './codex-structured-journal-limits'
import {
  admitCodexLifecycleItems,
  appendCodexLifecycleItem,
  appendCodexLifecycleMutations,
  publishCodexLifecycle
} from './codex-structured-journal-sink'
import type { CodexPendingJournalPrompt } from './codex-structured-journal-settlement'
import { readCodexTurnId } from './codex-structured-thread-facts'
import type { CodexRowAttribution } from './codex-subagent-linkage'
import { journalLifecycleItemMutation } from '../native-chat/agent-session-journal/journal-row-builders'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import {
  agentSessionPromptQuestions,
  legacyAgentSessionSelectedOptionId,
  type AgentSessionQuestionAnswer
} from '../../shared/agent-session-question-answer'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'

/** Resolved with the typed reply as the free-text answer; a reply without text records none. */
function answeredAsyncQuestionBody(
  body: AgentJournalItemBody,
  text: string | null,
  resolvedAt: number
): AgentJournalItemBody | null {
  if (body.kind !== 'question') {
    return null
  }
  const bounded = boundJournalPromptBody(body)
  const other = text?.trim()
    ? boundInlineText(text.trim(), DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
    : null
  const answers: AgentSessionQuestionAnswer[] = other
    ? agentSessionPromptQuestions(bounded).map((question) => ({
        questionId: question.id,
        optionIds: [],
        other
      }))
    : []
  return {
    ...bounded,
    resolution: {
      state: 'resolved',
      selectedOptionId: legacyAgentSessionSelectedOptionId(bounded, answers),
      ...(answers.length > 0 ? { answers } : {}),
      resolvedBy: null,
      resolvedAt
    }
  }
}

type CodexGroupedPendingJournalPrompt = CodexPendingJournalPrompt & {
  promptKey: string
  delivery?: 'async'
}

export class CodexJournalPrompts {
  readonly pending = new Map<string, CodexGroupedPendingJournalPrompt>()

  constructor(
    private readonly deps: Pick<CodexJournalTranslatorDeps, 'sink' | 'bindPromptItemId' | 'now'> & {
      attributionFor: CodexRowAttribution
    },
    private readonly detailFor: (threadId: string, itemId: string) => string | null,
    private readonly activeTurn: (threadId: string) => string | null
  ) {}

  handle(event: {
    threadId: string
    method: string
    params: unknown
    codexItemId: string
    promptKey: string
    delivery?: 'async'
  }): CodexJournalTranslationAdmission {
    const turnId = readCodexTurnId(event.params) ?? this.activeTurn(event.threadId)
    if (event.method === CODEX_USER_INPUT_METHOD) {
      const questions = codexQuestionItems({
        threadId: event.threadId,
        promptKey: event.promptKey,
        params: event.params
      })
      const promptItems = questions.map(({ identity, body }) => ({ identity, body }))
      const admission = this.admit(event, turnId, promptItems)
      if (!admission.accepted) {
        return admission
      }
      for (const question of promptItems) {
        const itemId = agentJournalItemKey(question.identity)
        this.pending.set(itemId, {
          threadId: event.threadId,
          turnId,
          promptKey: event.promptKey,
          identity: question.identity,
          body: question.body,
          ...(event.delivery ? { delivery: event.delivery } : {})
        })
        const trimAdmission = this.trim()
        if (!trimAdmission.accepted) {
          return trimAdmission
        }
        this.deps.bindPromptItemId?.(itemId, event.threadId, event.promptKey, turnId)
      }
      return CODEX_JOURNAL_ADMITTED
    }
    const identity = codexPromptIdentity({
      threadId: event.threadId,
      promptKey: event.promptKey
    })
    const body = codexApprovalItem({
      method: event.method,
      params: event.params,
      detail: this.detailFor(event.threadId, event.codexItemId)
    })
    const admission = this.admit(event, turnId, [{ identity, body }])
    if (!admission.accepted) {
      return admission
    }
    const itemId = agentJournalItemKey(identity)
    this.pending.set(itemId, {
      threadId: event.threadId,
      turnId,
      promptKey: event.promptKey,
      identity,
      body
    })
    const trimAdmission = this.trim()
    if (!trimAdmission.accepted) {
      return trimAdmission
    }
    this.deps.bindPromptItemId?.(itemId, event.threadId, event.promptKey, turnId)
    return CODEX_JOURNAL_ADMITTED
  }

  /** A user message on the thread answers every async ask still open there, in its own words. */
  answerAsync(threadId: string, text: string | null): CodexJournalTranslationAdmission {
    const answered = [...this.pending].filter(
      ([, prompt]) => prompt.delivery === 'async' && prompt.threadId === threadId
    )
    if (answered.length === 0) {
      return CODEX_JOURNAL_ADMITTED
    }
    const resolvedAt = this.deps.now?.() ?? Date.now()
    const mutations = answered.flatMap(([, prompt]) => {
      const body = answeredAsyncQuestionBody(prompt.body, text, resolvedAt)
      const producer = this.deps.attributionFor(prompt.threadId, prompt.turnId)
      return body ? [journalLifecycleItemMutation(producer, prompt.identity, body)] : []
    })
    const admission = appendCodexLifecycleMutations(
      this.deps.sink,
      `prompt-answered:${encodeURIComponent(threadId)}:${encodeURIComponent(answered[0]![0])}`,
      mutations
    )
    if (admission.accepted) {
      for (const [itemId] of answered) {
        this.pending.delete(itemId)
      }
    }
    return admission
  }

  resolve(journalItemId: string): void {
    this.pending.delete(journalItemId)
  }

  cancel(journalItemId: string): CodexJournalTranslationAdmission {
    const selected = this.pending.get(journalItemId)
    if (!selected) {
      return CODEX_JOURNAL_ADMITTED
    }
    const group = [...this.pending].filter(
      ([, prompt]) =>
        prompt.threadId === selected.threadId &&
        prompt.turnId === selected.turnId &&
        prompt.promptKey === selected.promptKey
    )
    const mutations = group.flatMap(([, prompt]) => {
      const body = cancelledJournalPromptBody(prompt.body)
      const producer = this.deps.attributionFor(prompt.threadId, prompt.turnId)
      return body ? [journalLifecycleItemMutation(producer, prompt.identity, body)] : []
    })
    const admission = appendCodexLifecycleMutations(
      this.deps.sink,
      `prompt-cancelled:${encodeURIComponent(selected.threadId)}:${encodeURIComponent(
        selected.promptKey
      )}:${encodeURIComponent(selected.turnId ?? 'unbound')}`,
      mutations
    )
    if (admission.accepted) {
      for (const [itemId] of group) {
        this.pending.delete(itemId)
      }
    }
    return admission
  }

  dispose(): void {
    this.pending.clear()
  }

  private admit(
    event: { method: string; threadId: string; promptKey: string },
    turnId: string | null,
    items: readonly Pick<CodexPendingJournalPrompt, 'identity' | 'body'>[]
  ): CodexJournalTranslationAdmission {
    return admitCodexLifecycleItems(
      this.deps.sink,
      `prompt:${encodeURIComponent(event.method)}:${encodeURIComponent(
        event.threadId
      )}:${encodeURIComponent(event.promptKey)}`,
      items,
      // A child's approval arrives on the child's own thread, so it names the asker.
      this.deps.attributionFor(event.threadId, turnId)
    )
  }

  private trim(): CodexJournalTranslationAdmission {
    while (this.pending.size > MAX_CODEX_PENDING_PROMPTS) {
      const oldest = this.pending.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      const evicted = this.pending.get(oldest)
      if (evicted) {
        const cancelled = cancelledJournalPromptBody(evicted.body)
        if (cancelled) {
          const admission = appendCodexLifecycleItem(
            this.deps.sink,
            evicted.identity,
            cancelled,
            this.deps.attributionFor(evicted.threadId, evicted.turnId)
          )
          if (!admission.accepted) {
            return admission
          }
          const published = publishCodexLifecycle(this.deps.sink)
          if (!published.accepted) {
            return published
          }
        }
      }
      this.pending.delete(oldest)
    }
    return CODEX_JOURNAL_ADMITTED
  }
}
