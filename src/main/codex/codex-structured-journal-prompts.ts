import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { cancelledJournalPromptBody } from '../native-chat/agent-session-journal/journal-prompt-body-bounds'
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

type CodexGroupedPendingJournalPrompt = CodexPendingJournalPrompt & { promptKey: string }

export class CodexJournalPrompts {
  readonly pending = new Map<string, CodexGroupedPendingJournalPrompt>()

  constructor(
    private readonly deps: Pick<CodexJournalTranslatorDeps, 'sink' | 'bindPromptItemId'>,
    private readonly detailFor: (threadId: string, itemId: string) => string | null,
    private readonly activeTurn: (threadId: string) => string | null
  ) {}

  handle(event: {
    threadId: string
    method: string
    params: unknown
    codexItemId: string
    promptKey: string
  }): CodexJournalTranslationAdmission {
    const turnId = readCodexTurnId(event.params) ?? this.activeTurn(event.threadId)

    if (event.method === CODEX_USER_INPUT_METHOD) {
      const questions = codexQuestionItems({
        threadId: event.threadId,
        promptKey: event.promptKey,
        params: event.params
      })

      const promptItems = questions.map(({ identity, body }) => ({ identity, body }))
      const admission = this.admit(event, promptItems)

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
          body: question.body
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

    const admission = this.admit(event, [{ identity, body }])

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

      return body ? [{ kind: 'item' as const, identity: prompt.identity, body }] : []
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
    items: readonly Pick<CodexPendingJournalPrompt, 'identity' | 'body'>[]
  ): CodexJournalTranslationAdmission {
    return admitCodexLifecycleItems(
      this.deps.sink,
      `prompt:${encodeURIComponent(event.method)}:${encodeURIComponent(
        event.threadId
      )}:${encodeURIComponent(event.promptKey)}`,
      items
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
          const admission = appendCodexLifecycleItem(this.deps.sink, evicted.identity, cancelled)

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
