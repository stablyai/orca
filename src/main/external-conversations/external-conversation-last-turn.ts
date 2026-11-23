// Which side began a linked chat's latest turn: its conversation, or someone in Orca.
import type { ExternalConversationTurnSource } from '../../shared/connectors/external-conversation-link'
import type { AgentPaneWorkspace } from '../agent-hooks/observations/agent-transition-detector'
import type { AdmittedMessage } from '../native-chat/agent-session-wire/host/structured-agent-session-host-types'
import { conversationOwnsTurn } from './external-conversation-chat-turns'
import { isConversationReport } from './external-conversation-turn-opener'
import { readLinks, type ExternalConversationLinkStore } from './external-conversation-links'
import { writeLinkFact } from './external-conversation-link-writes'
import type { ConversationKey } from './external-conversation-types'

type LastTurnDeps = { store: ExternalConversationLinkStore; onLinked?: () => void }

/** The row names the thread only when the thread began the latest turn, as Slack hears it. */
export function recordLastTurn(
  deps: LastTurnDeps,
  key: ConversationKey,
  lastTurn: ExternalConversationTurnSource,
  workspace: AgentPaneWorkspace
): void {
  if (writeLinkFact(deps.store, key, { lastTurn }, workspace)) {
    deps.onLinked?.()
  }
}

/**
 * A message a chat took, as its host admitted it: the turn it opens is its conversation's when the
 * message is a delivery or mail finishing its ask, else Orca's (typed, other mail, an automation). One
 * joining a running turn only ever makes it the conversation's, and one of Orca's joining clears the
 * tasks whose wake-ups answer it. Recovery sends are not triggers.
 */
export function recordAdmittedTurn(
  deps: LastTurnDeps,
  { sessionId, workspaceId, body, joinsRunningTurn }: AdmittedMessage
): void {
  const workspace = { worktreeId: workspaceId, sshHostId: null }
  const link = readLinks(deps.store, workspace).find((entry) => entry.sessionId === sessionId)
  const owned =
    link &&
    conversationOwnsTurn(link, {
      delivered: () => body.origin === 'connector',
      reported: () => isConversationReport(body)
    })
  if (link && (owned || !joinsRunningTurn)) {
    recordLastTurn(deps, link, owned ? 'conversation' : 'orca', workspace)
  }
  // Someone in Orca steering into a running turn (a wake-up's included) makes what it does next
  // theirs too, so no task's wake-up answers the conversation from here; a missed post beats a
  // private one.
  if (link?.wakeAnswers && !owned && joinsRunningTurn) {
    writeLinkFact(deps.store, link, { wakeAnswers: undefined }, workspace)
  }
}
