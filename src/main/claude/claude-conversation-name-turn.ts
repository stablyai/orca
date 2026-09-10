// Naming a Claude conversation.
//
// Claude's stream-json protocol carries no title frame, and the CLI's own
// auto-titling does not fire in practice for a session driven over stream-json
// on current builds. The Agent SDK exposes the request directly, so Orca
// asks once, and `persist` makes the CLI write the answer into its transcript as
// the `ai-title` record a later attach reads back.
//
// Deliberately NOT Codex's imperative-verb style: Claude's own titling is a short
// noun phrase in sentence case, and the SDK call already produces that. Passing
// the user's text as the description and nothing else keeps it that way.

import type { AgentJournalMessageItem } from '../../shared/agent-session-journal-types'
import { agentSessionNamingPromptText } from '../native-chat/agent-session-wire/agent-session-naming-prompt-text'
import type { ClaudeSession } from './claude-structured-session-state'
import type { ClaudeConversationNameReporter } from './claude-transcript-conversation-name'

export type ClaudeConversationNamingDeps = {
  requestTimeoutMs?: number
  readTranscriptConversationName?: ClaudeConversationNameReporter['readTranscriptConversationName']
  onConversationName?: (sessionId: string, conversationName: string) => void
  /** The durable naming state. Claude rebuilds its session object on every
   *  acquisition, so an in-memory flag alone would retitle the conversation —
   *  and pay for it — on the second message after every eviction. */
  readNamingState?: (sessionId: string) => {
    conversationName: string | null
    namingAttempted: boolean
  }
  markNamingAttempted?: (sessionId: string) => void
  onError?: (scope: string, error: unknown) => void
}

/**
 * Names the session once, off the turn's critical path.
 *
 * Asked at most once per CONVERSATION rather than once per session object.
 * Nothing here may turn a delivered message into a reported failure: this sits
 * on the send path, so the provider call runs inside the promise and the prompt
 * reader is total by construction.
 */
export function startClaudeConversationNaming(
  sessionId: string,
  session: ClaudeSession,
  body: AgentJournalMessageItem,
  deps: ClaudeConversationNamingDeps
): void {
  if (session.namingAttempted || !deps.onConversationName) {
    return
  }
  // Claimed only once there is text to name from. A caption-free screenshot as
  // the first message would otherwise spend the conversation's one attempt and
  // leave it on the placeholder for good.
  const description = agentSessionNamingPromptText(body)
  if (!description) {
    return
  }
  session.namingAttempted = true
  void Promise.resolve()
    .then(async () => {
      const existing = await session.conversationNameRead
      if (existing && existing.kind !== 'unknown') {
        return
      }
      const durable = deps.readNamingState?.(sessionId)
      if (durable?.conversationName || durable?.namingAttempted) {
        return
      }
      const result = await session.connection.generateSessionTitle(description, {
        persist: true,
        ...(deps.requestTimeoutMs ? { timeoutMs: deps.requestTimeoutMs } : {})
      })
      // A CLI with no title request must stay askable: marking it here would
      // mean none of this build's conversations could ever be named, even after
      // the user upgrades. A thrown request is likewise left unmarked.
      if (result.outcome === 'unsupported') {
        return
      }
      if (hasPublishedName()) {
        return
      }
      let title = result.outcome === 'named' ? result.title : null
      if (title && deps.readTranscriptConversationName) {
        const persisted = await deps.readTranscriptConversationName({
          providerSessionId: session.providerSessionId,
          claudeConfigDir: session.claudeConfigDir
        })
        if (hasPublishedName()) {
          return
        }
        if (persisted.kind === 'named') {
          title = persisted.title
        }
        if (persisted.kind === 'cleared') {
          title = null
        }
      }
      deps.markNamingAttempted?.(sessionId)
      if (title) {
        deps.onConversationName?.(sessionId, title)
      }

      function hasPublishedName(): boolean {
        const current = deps.readNamingState?.(sessionId)
        return Boolean(current?.conversationName || current?.namingAttempted)
      }
    })
    .catch((error: unknown) => deps.onError?.('claude-conversation-naming', error))
}
