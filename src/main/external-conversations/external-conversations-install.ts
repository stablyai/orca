import { setConnectorClaimSource } from '../native-chat/agent-session-wire/recovery/structured-agent-session-connector-claims'
import type { AgentTransitionDetector } from '../agent-hooks/observations/agent-transition-detector'
import type { RuntimeWorktreeLifecycleEvent } from '../runtime/workspaces/lifecycle/worktree-lifecycle-event'
import { isRefOf } from '../../shared/connector-place-names'
import type { ConnectorRefResolver } from '../connector-cloud/connector-ref-resolution'
import type { Bot } from '../../shared/bot-types'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { SlackMirror } from './slack-mirror'
import { connectorAskerImages } from './connector-asker-images'
import { postConnectorAction } from '../connector-cloud/connector-actions'
import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { SlackMirrorCloud } from './slack-mirror-cloud'
import { DeliveryReceipts, type DeliveryReceiptDb } from './external-conversation-delivery-receipts'
import { allLinks, type ExternalConversationLinkStore } from './external-conversation-links'
import { markThreadSeen } from './external-conversation-link-writes'
import { ExternalConversationSeam } from './external-conversation-seam'
import {
  conversationReplyFill,
  type ConversationReplyFill
} from './external-conversation-reply-fill'
import { ConnectorReplyRecovery } from './external-conversation-reply-recovery'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { canonicalOrcaSessionId } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import { threadActsFor } from '../../shared/bots/bot-acts-for'
import {
  readBotConversationActsFor,
  type BotConversationActsForSources
} from '../bots/bot-conversation-acts-for'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import {
  CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE,
  type ConnectorCloudFeature
} from '../../shared/connector-cloud-features'

/** The seam is local and subscribes to nothing until watched, so it lives for the process, built on first use. */
export function installExternalConversations(
  store: (ExternalConversationLinkStore & { getBots?: () => readonly Bot[] }) | null,
  runtime: {
    getOrchestrationDb: () => DeliveryReceiptDb & OrchestrationDb
    listAutomationRuns: BotConversationActsForSources['listAutomationRuns']
    showAutomation: BotConversationActsForSources['showAutomation']
    onWorktreeLifecycle: (listener: (event: RuntimeWorktreeLifecycleEvent) => void) => () => void
    agentTransitions: Pick<AgentTransitionDetector, 'latestRow' | 'subscribe'>
    onConversationLinked?: () => void
    getConnectorCloud?: () =>
      | (SlackMirrorCloud & {
          refResolver(): ConnectorRefResolver | null
          orcaAccountName(): string
          repliesFilled(): void
        })
      | null
  }
): {
  current(): ExternalConversationSeam | null
  /** Posts the owner's Orca-typed messages to their bot chats' Slack threads; lives with the seam. */
  slackMirror(): SlackMirror | null
  /** A bot thread in this chat is no longer new, on every client. */
  threadSeen(sessionId: string): void
} {
  if (!store) {
    return { current: () => null, slackMirror: () => null, threadSeen: () => {} }
  }
  let seam: ExternalConversationSeam | null = null
  let mirror: SlackMirror | null = null
  const linked = () => runtime.onConversationLinked?.()
  const current = (): ExternalConversationSeam => {
    if (seam) {
      return seam
    }
    const made = (signal: AbortSignal) =>
      new SlackMirror({
        store,
        cloud: () => runtime.getConnectorCloud?.() ?? null,
        orcaName: () => runtime.getConnectorCloud?.()?.orcaAccountName() ?? '',
        botSetting: (botId) => store.getBots?.().find((bot) => bot.id === botId)?.slackMirror,
        readMessage: async (sessionId, itemId) => {
          const reads = await getStructuredAgentSessionHost()?.journalReads(sessionId)
          const item = await reads?.item(itemId)
          return item?.body.kind === 'message' ? item.body : null
        },
        emitTurnEnd: (event) => seam?.tellTurnEnd(event) ?? false,
        onLinked: linked,
        signal
      })
    let replyOutbox: ReturnType<typeof connectorReplyOutbox> | null = null
    seam = new ExternalConversationSeam({
      slackMirror: () => mirror,
      replyFill: () => replyOutbox?.fill ?? null,
      replyAdmitted: (sessionId) => replyOutbox?.admitted(sessionId),
      store,
      receipts: new DeliveryReceipts(() => runtime.getOrchestrationDb()),
      onWorkspaceRemoved: (listener) =>
        runtime.onWorktreeLifecycle((event) => {
          if (event.kind === 'removed') {
            listener(event.worktreeId)
          }
        }),
      readHookRow: (paneKey) => runtime.agentTransitions.latestRow(paneKey),
      onAgentPaneChange: (listener) => runtime.agentTransitions.subscribe(listener),
      onLinked: () => runtime.onConversationLinked?.(),
      // Through the cloud a bot's own `read --download` goes through, into the attachment store.
      askerImages: connectorAskerImages({
        read: async ({ botId, ref, fileId, conversation }, imageSignal) => {
          const cloud = runtime.getConnectorCloud?.()
          const about = cloudConversation(conversation)
          // A cloud that can't stream a file leaves it to the agent's own download.
          if (!cloud?.cloudFeatures()?.has('files.direct' satisfies ConnectorCloudFeature)) {
            return null
          }
          return await postConnectorAction(
            cloud,
            {
              botId,
              verb: 'read',
              ref,
              args: { download: fileId, stream: true },
              ...(about ? { conversation: about } : {})
            },
            imageSignal
          )
        },
        store: async (name, bytes) => {
          const attachments = getAgentSessionAttachmentStore()
          if (!attachments) {
            throw new Error('no attachment store')
          }
          return await attachments.storeFile(name, bytes)
        }
      }),
      // An older cloud without refs names no channel; the row then shows Slack's name.
      nameChannel: async (botId, channelId) => {
        const resolve = runtime.getConnectorCloud?.()?.refResolver()
        const label = resolve ? (await resolve(botId, 'slack', 'place', channelId)).label : null
        return label && !isRefOf('slack', label) ? label : null
      },
      // Keyed by the chat's /clear root, as it was recorded.
      actsForOf: (sessionId) => {
        const recorded = readBotConversationActsFor(
          runtime,
          isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
        )
        return recorded && threadActsFor(recorded.actsFor)
      },
      freesGoneChats: () =>
        runtime
          .getConnectorCloud?.()
          ?.cloudFeatures()
          ?.has('threads.owner' satisfies ConnectorCloudFeature) === true,
      promptsAudience: () =>
        runtime
          .getConnectorCloud?.()
          ?.cloudFeatures()
          ?.has(CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE) === true
    })
    mirror = made(seam.signal)
    replyOutbox = connectorReplyOutbox(store, runtime, seam.signal)
    return seam
  }
  return {
    current,
    slackMirror: () => (current(), mirror),
    threadSeen: (sessionId) => {
      if (markThreadSeen(store, sessionId)) {
        runtime.onConversationLinked?.()
      }
    }
  }
}

/** The reply outbox's fill, boot recovery and watch (design item 125), for one enabled seam. */
function connectorReplyOutbox(
  store: ExternalConversationLinkStore,
  runtime: {
    getConnectorCloud?: () => { repliesFilled(): void } | null
    structuredAgentSessionLaunchContinuation?: { continued: Promise<unknown> }
  },
  signal: AbortSignal
): { fill: ConversationReplyFill; admitted: (sessionId: string) => void } {
  const journal = () => getStructuredAgentSessionHost()?.deps.store.connectorReplies() ?? null
  const filled = () => runtime.getConnectorCloud?.()?.repliesFilled()
  const fill = conversationReplyFill(journal, filled)
  const recovery = new ConnectorReplyRecovery({
    journal,
    chat: getStructuredAgentSessionHost,
    hasSession: (sessionId) =>
      getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId) != null,
    isBot: (sessionId) =>
      [...allLinks(store)].some(({ link }) => link.sessionId === sessionId && link.bot),
    agentOf: (sessionId) =>
      [...allLinks(store)].find(({ link }) => link.sessionId === sessionId)?.link.agent ?? '',
    fillTurn: fill,
    filled,
    // This start's own continuations of restart cuts claim first; whatever they left closes then.
    ...(runtime.structuredAgentSessionLaunchContinuation
      ? { continuationsSettled: runtime.structuredAgentSessionLaunchContinuation.continued }
      : {})
  })
  setConnectorClaimSource((sessionId, cut) => recovery.claimFor(sessionId, cut))
  const boot = () => {
    recovery.dispose()
    if (getStructuredAgentSessionHost()) {
      void recovery.boot()
    }
  }
  const stop = onStructuredAgentSessionHostChanged(boot)
  signal.addEventListener('abort', () => {
    stop()
    setConnectorClaimSource(null)
    recovery.dispose()
  })
  boot()
  return {
    fill: async (turn) => {
      const covered = await fill(turn)
      recovery.turnEnded(turn.sessionId)
      return covered
    },
    admitted: (sessionId) => recovery.admitted(sessionId)
  }
}
