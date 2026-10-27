// What a hello's snapshot tells the cloud: recently active cloud conversations, within the contract's caps.
import type { PendingPrompt } from '../../shared/agent-pending-prompt'
import {
  cloudConversation,
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorEvent
} from '../../shared/connector-cloud-contract'
import type { ConversationSnapshot } from '../external-conversations/external-conversation-events'

type Snapshot = Extract<ConnectorEvent, { kind: 'snapshot' }>

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/** A prompt too large to carry, offered as one only Orca can answer. */
export const unsupported = (prompt: PendingPrompt): PendingPrompt => ({
  kind: 'unsupported',
  promptId: prompt.promptId
})

/**
 * Linked conversations active within the window, newest first, at most maxSnapshotConversations. Working
 * or prompting counts as active now. Past the event cap, prompts go unsupported, then the least recent go.
 * `trimmed` says whether a recently active conversation was left out.
 */
export function connectorSnapshot(
  event: ConversationSnapshot,
  now: number
): { snapshot: Snapshot; trimmed: boolean } {
  const since = now - CONNECTOR_CLIENT_LIMITS.snapshotActiveWindowMs
  const recent = event.conversations
    .flatMap((entry) => {
      const conversation = cloudConversation(entry.conversation)
      const activeAt = entry.working || entry.prompt ? now : entry.activeAt
      return conversation && activeAt >= since ? [{ ...entry, conversation, activeAt }] : []
    })
    .sort((a, b) => b.activeAt - a.activeAt)
  let conversations: Snapshot['conversations'] = recent
    .slice(0, CONNECTOR_CLIENT_LIMITS.maxSnapshotConversations)
    .map(({ conversation, paneKey, agent, working, prompt, turnId }) => ({
      conversation,
      paneKey,
      agent,
      working,
      prompt,
      ...(turnId === null ? {} : { turnId })
    }))
  const fits = (): boolean =>
    jsonBytes({ kind: 'snapshot', conversations }) <= CONNECTOR_CLIENT_LIMITS.maxEventBytes
  if (!fits()) {
    conversations = conversations.map((entry) =>
      entry.prompt ? { ...entry, prompt: unsupported(entry.prompt) } : entry
    )
  }
  while (conversations.length > 0 && !fits()) {
    conversations = conversations.slice(0, -1)
  }
  return {
    snapshot: { kind: 'snapshot', conversations },
    trimmed: conversations.length < recent.length
  }
}
