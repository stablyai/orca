import {
  slackMirrorAvailable,
  slackMirrorMayPost
} from '../../shared/connectors/slack-mirror-state'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { AgentSessionRecoveryCapsule } from '../runtime/agent-session/records/agent-session-recovery-capsule'
import {
  onRecoveryCapsulePublished,
  readStandingRecoveryOffers
} from '../runtime/agent-session/records/agent-session-recovery-capsule-file'
import type { ExternalConversationLink } from '../../shared/connectors/external-conversation-link'
import { allLinks, type ExternalConversationLinkStore } from './external-conversation-links'
import type { ReplyRecoveryOffers } from './external-conversation-reply-recovery'

// What reply recovery reads beyond the journal (design: slack-reply-lost-restart): the restart
// offers a continuation may still answer, and whether a chat's Slack mirror tells a thread itself.

/** The running host's restart offers (the recovery capsule); null while no host keeps them. */
export function replyRecoveryOffers(): ReplyRecoveryOffers | null {
  const capsule = getStructuredAgentSessionHost()?.deps.recoveryCapsule
  return capsule ? capsuleReplyOffers(capsule) : null
}

/** A capsule's offers as reply recovery reads them: every one a continuation may still answer. */
export function capsuleReplyOffers(
  capsule: Pick<AgentSessionRecoveryCapsule, 'filePath'>
): ReplyRecoveryOffers {
  return {
    read: async (now) =>
      (await readStandingRecoveryOffers(capsule.filePath, now)).map((marker) => ({
        sessionId: marker.sessionId,
        work: marker.work
      })),
    onChange: (listener) => onRecoveryCapsulePublished(capsule.filePath, listener)
  }
}

/** Whether the chat's Slack mirror posts a turn these person-typed messages joined into this
 *  conversation: a thread chat that posts back now, or one that already recorded one of them. Errs
 *  toward yes: then the recovered row closes quietly, never a second post. */
export function replyRecoveryMirrorsTo(
  store: ExternalConversationLinkStore
): (sessionId: string, externalId: string, personItemIds: readonly string[]) => boolean {
  return (sessionId, externalId, personItemIds) => {
    for (const { link } of allLinks(store)) {
      if (link.sessionId === sessionId && link.externalId === externalId) {
        return linkMirrorsTo(link, personItemIds)
      }
    }
    return false
  }
}

/** One link's answer: a thread chat that can post back, and does now or already posted one of them. */
export function linkMirrorsTo(
  link: ExternalConversationLink,
  personItemIds: readonly string[]
): boolean {
  return (
    slackMirrorAvailable(link) &&
    (slackMirrorMayPost(link) || personItemIds.some((itemId) => link.mirrorPosts?.[itemId]))
  )
}
