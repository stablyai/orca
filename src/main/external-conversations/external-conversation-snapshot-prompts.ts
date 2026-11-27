import type { PromptPublication } from './external-conversation-prompt-publication'
import type { AgentJournalCursor } from '../../shared/agent-session/journal/agent-session-journal-identity'
import type { ConnectorPrompt } from '../../shared/connectors/connector-cloud-contract'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import type { StructuredAgentSessionPromptStanding } from '../native-chat/agent-session-wire/observations/structured-agent-session-prompt-standing'
import { conversationId, type ConversationKey } from './external-conversation-types'

type PromptLink = Pick<ExternalConversationLink, 'source' | 'externalId' | 'paneKey' | 'sessionId'>
type PromptOccurrence = {
  cursor: AgentJournalCursor | undefined
  taken: object | null
  order: number
}
type Attempt = { order: number; prompt: ConnectorPrompt; occurrence: PromptOccurrence }
type ConversationPrompts = {
  paneKey: string
  sessionId: string
  epoch: string | undefined
  prompts: Map<string, PromptOccurrence>
  last: Attempt | null
  pending: Set<Attempt>
}

export type SnapshotPromptSource = 'live' | 'restated' | 'none'

/** Why a snapshot entry reads as it does, for the snapshot's trace only; never sent. */
export type SnapshotEntryTrace = {
  sessionId?: string
  promptId?: string | null
  heard: 'told' | 'delivery' | 'report' | 'none'
  prompt: SnapshotPromptSource
  standing?: StructuredAgentSessionPromptStanding
}
/** Only attempted eligible wire forms survive a watch; raw local observations grant no publication. */
export class ShownPrompts {
  private readonly conversations = new Map<string, ConversationPrompts>()
  private generationValue = 0
  private nextOrder = 0

  get generation(): number {
    return this.generationValue
  }

  offer(
    link: PromptLink,
    promptId: string,
    readCursor?: () => AgentJournalCursor | undefined
  ): PromptPublication {
    const key = conversationId(link)
    const cursor = readCursor?.()
    let conversation = this.conversations.get(key)
    if (
      !conversation ||
      conversation.paneKey !== link.paneKey ||
      conversation.sessionId !== link.sessionId ||
      (cursor && conversation.epoch && cursor.epoch !== conversation.epoch)
    ) {
      conversation = {
        paneKey: link.paneKey,
        sessionId: link.sessionId,
        epoch: cursor?.epoch,
        prompts: new Map(),
        last: null,
        pending: new Set()
      }
      this.conversations.set(key, conversation)
    }
    const target = conversation
    const occurrence = target.prompts.get(promptId) ?? { cursor, taken: null, order: 0 }
    target.prompts.set(promptId, occurrence)
    if (cursor) {
      occurrence.cursor = cursor
      target.epoch = cursor.epoch
    }
    return {
      start: (prompt) => {
        if (
          this.conversations.get(key) !== target ||
          target.prompts.get(promptId) !== occurrence ||
          prompt.promptId !== promptId
        ) {
          return () => {}
        }
        const atSend = readCursor?.()
        if (atSend && target.epoch && atSend.epoch !== target.epoch) {
          return () => {}
        }
        if (atSend) {
          occurrence.cursor = atSend
          target.epoch = atSend.epoch
        }
        const attempt = { order: ++this.nextOrder, prompt: structuredClone(prompt), occurrence }
        occurrence.order = attempt.order
        target.pending.add(attempt)
        return (status) => {
          target.pending.delete(attempt)
          if (
            this.conversations.get(key) !== target ||
            target.prompts.get(promptId) !== occurrence
          ) {
            return
          }
          const possible =
            typeof status !== 'number' || status >= 500 || (status >= 200 && status < 300)
          if (possible && (!target.last || target.last.order < attempt.order)) {
            target.last = attempt
            for (const [id, old] of target.prompts) {
              if (old !== occurrence && old.order > 0 && old.order < attempt.order) {
                target.prompts.delete(id)
              }
            }
          }
        }
      }
    }
  }

  restate(
    link: PromptLink,
    standing: (
      promptId: string,
      cursor?: AgentJournalCursor
    ) => StructuredAgentSessionPromptStanding
  ): {
    prompt: ConnectorPrompt | null
    promptId: string
    standing: StructuredAgentSessionPromptStanding
  } | null {
    const key = conversationId(link)
    const target = this.conversations.get(key)
    if (!target) {
      return null
    }
    if (target.paneKey !== link.paneKey || target.sessionId !== link.sessionId) {
      this.conversations.delete(key)
      return null
    }
    let shown = target.last
    for (const attempt of target.pending) {
      if (
        target.prompts.get(attempt.prompt.promptId) === attempt.occurrence &&
        (!shown || shown.order < attempt.order)
      ) {
        shown = attempt
      }
    }
    if (!shown) {
      for (const [id, occurrence] of target.prompts) {
        if (standing(id, occurrence.cursor) === 'gone') {
          target.prompts.delete(id)
        }
      }
      return null
    }
    const now = standing(shown.prompt.promptId, shown.occurrence.cursor)
    if (now === 'gone') {
      this.forgetPrompt(target.paneKey, shown.prompt.promptId)
    }
    if (shown.occurrence.taken) {
      return null
    }
    return {
      prompt: now === 'gone' ? null : shown.prompt,
      promptId: shown.prompt.promptId,
      standing: now
    }
  }

  take(paneKey: string, promptId: string): () => boolean {
    const entry = [...this.conversations].find(
      ([, target]) => target.paneKey === paneKey && target.prompts.has(promptId)
    )
    if (!entry) {
      return () => false
    }
    const [key, target] = entry
    const occurrence = target.prompts.get(promptId)!
    const taken = (occurrence.taken = {})
    return () => {
      if (
        this.conversations.get(key) !== target ||
        target.prompts.get(promptId) !== occurrence ||
        occurrence.taken !== taken
      ) {
        return false
      }
      occurrence.taken = null
      return true
    }
  }

  forgetConversation(conversation: ConversationKey): void {
    this.conversations.delete(conversationId(conversation))
  }

  forgetPane(paneKey: string): void {
    for (const [key, target] of this.conversations) {
      if (target.paneKey === paneKey) {
        this.conversations.delete(key)
      }
    }
  }

  forgetPrompt(paneKey: string, promptId: string): void {
    for (const target of this.conversations.values()) {
      if (target.paneKey !== paneKey) {
        continue
      }
      const occurrence = target.prompts.get(promptId)
      if (!occurrence) {
        continue
      }
      for (const [id, old] of target.prompts) {
        if (id === promptId || (old.order > 0 && old.order <= occurrence.order)) {
          target.prompts.delete(id)
        }
      }
      if (target.last && !target.prompts.has(target.last.prompt.promptId)) {
        target.last = null
      }
      for (const pending of target.pending) {
        if (!target.prompts.has(pending.prompt.promptId)) {
          target.pending.delete(pending)
        }
      }
    }
  }

  reset(): void {
    this.generationValue += 1
    this.conversations.clear()
  }
}
