// A conversation's place as people name it, kept on its link so a bot's sidebar row can say where it is.
import type { ConnectorAsker } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorSource } from '../../shared/connectors/external-conversation-link'
import { findLink, type ExternalConversationLinkStore } from './external-conversation-links'
import { writeLinkFact } from './external-conversation-link-writes'
import type { ConversationKey } from './external-conversation-types'

/** A Slack channel's name through Orca Cloud's find ("#orca"); null when it can't say. */
export type ConversationPlaceNamer = (botId: string, channelId: string) => Promise<string | null>

const GITHUB_REPO_THREAD = /^[^/]+\/([^/#]+#\d+)$/

/** The asker's place as people name it; null for a direct message, or a Slack channel, which only the cloud names. */
export function conversationPlaceLabel(
  source: ConnectorSource,
  place: ConnectorAsker['place']
): string | null {
  if (place.kind === 'direct_message' || place.kind === 'group_message') {
    return null
  }
  if (source === 'github') {
    // owner/repo#12 reads as repo#12.
    return GITHUB_REPO_THREAD.exec(place.id)?.[1] ?? place.id
  }
  return source === 'linear' ? place.id : null
}

/** Named once: a link that already has its place is never looked up again. */
export async function nameConversationPlace(
  source: ConnectorSource,
  place: ConnectorAsker['place'],
  botId: string,
  nameChannel: ConversationPlaceNamer | undefined
): Promise<string | null> {
  const known = conversationPlaceLabel(source, place)
  const channel =
    source === 'slack' && place.kind !== 'direct_message' && place.kind !== 'group_message'
  return known ?? (channel && nameChannel ? nameChannel(botId, place.id).catch(() => null) : null)
}

/** A bot's conversation keeps where it is, for its sidebar row; looked up once per conversation. */
export async function nameLinkedPlace(
  deps: {
    store: ExternalConversationLinkStore
    nameChannel?: ConversationPlaceNamer
    onLinked?: () => void
  },
  key: ConversationKey,
  botId: string,
  place: ConnectorAsker['place'],
  signal: AbortSignal
): Promise<void> {
  if (findLink(deps.store, key)?.link.place) {
    return
  }
  const label = await nameConversationPlace(key.source, place, botId, deps.nameChannel)
  if (label && !signal.aborted && writeLinkFact(deps.store, key, { place: label })) {
    deps.onLinked?.()
  }
}
