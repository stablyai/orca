// The people the cloud stamped on a message, as the askers its turn acts for.
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { ConnectorMessageAsker } from '../../shared/connector-message-asker'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'

export function stampedPerson(
  asker: ConnectorMessageAsker,
  workspaceId: string | null
): BotRequestAsker {
  return {
    kind: 'person',
    source: asker.source,
    userId: asker.userId,
    ...(asker.name ? { name: asker.name } : {}),
    workspaceId,
    // Another Slack app is no person: never the owner, nor a member with their rights.
    role: asker.app ? null : asker.role,
    placeKind: asker.place.kind
  }
}

/** Who asked the messages a message carried in: its turn is held to them too. */
export function carriedAskersOf(
  body: AgentJournalItemBody,
  workspaceId: string | null
): BotRequestAsker[] {
  return body.kind === 'message'
    ? (body.carriedAskers ?? []).map((asker) =>
        asker ? stampedPerson(asker, workspaceId) : { kind: 'unknown' }
      )
    : []
}
