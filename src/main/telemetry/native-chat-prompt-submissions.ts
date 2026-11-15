import { tuiAgentToAgentKind } from '../../shared/agent-kind'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import type { EventProps } from '../../shared/telemetry-events'
import type { JournalWriterCommit } from '../native-chat/agent-session-journal/journal-writer-changes'
import type { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { recordStructuredChatPromptAccepted } from './structured-chat-dispatch'

type PromptSource = EventProps<'native_chat_prompt_submitted'>
const pendingPrompts = new WeakMap<
  AgentSessionJournal,
  Map<string, { source: PromptSource; ownerKey?: string }>
>()
const MAX_PENDING_PROMPTS_PER_JOURNAL = 256

/** Fresh user sends retain device provenance through queued-message conversion, without persisting telemetry state. */
export function rememberNativeChatPrompt(
  journal: AgentSessionJournal,
  clientMessageId: string,
  agent: string,
  userClient: 'desktop' | 'mobile' | undefined,
  ownerKey?: string
): void {
  if (!userClient) {
    return
  }
  let pending = pendingPrompts.get(journal)
  if (!pending) {
    pending = new Map()
    pendingPrompts.set(journal, pending)
  }
  if (pending.has(clientMessageId)) {
    return
  }
  if (pending.size >= MAX_PENDING_PROMPTS_PER_JOURNAL) {
    const oldest = pending.keys().next().value
    if (oldest !== undefined) {
      pending.delete(oldest)
    }
  }
  pending.set(clientMessageId, {
    ownerKey,
    source: {
      agent_kind: isTuiAgent(agent) ? tuiAgentToAgentKind(agent) : 'other',
      // The host cannot establish the desktop renderer's execution-target classification.
      runtime: 'unknown',
      client: userClient
    }
  })
}

export function forgetNativeChatPrompt(
  journal: AgentSessionJournal,
  clientMessageId: string
): void {
  pendingPrompts.get(journal)?.delete(clientMessageId)
}

/** Observe only committed transitions, never history snapshots, local reservations or handover preambles. */
export function observeNativeChatPromptSubmissions(
  journal: AgentSessionJournal,
  commit: JournalWriterCommit | undefined
): void {
  const pending = pendingPrompts.get(journal)
  if (!pending?.size || !commit) {
    return
  }
  if (commit.publication?.resetPrompts || commit.forkInstalled) {
    pending.clear()
  }
  for (const card of commit.publication?.cards ?? []) {
    if (card.state === 'withdrawn') {
      pending.delete(card.messageId)
    }
  }
  for (const row of commit.publication?.promptDispatches ?? []) {
    const sourceId = row.queuedMessageId ?? row.clientMessageId
    const source = pending.get(sourceId)
    if (row.state === 'accepted' && source) {
      pending.delete(sourceId)
      try {
        recordStructuredChatPromptAccepted(source.source, source.ownerKey)
      } catch (error) {
        console.warn('[telemetry] native chat prompt observation failed', error)
      }
    } else if (row.state === 'rejected' && !row.queuedMessageId) {
      pending.delete(sourceId)
    }
  }
}
