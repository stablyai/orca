import type { RuntimeStore } from '../runtime/construction/runtime-store-contract'
import {
  installLeaveLines,
  leaveLines,
  type LeaveLinesCloud
} from './external-conversation-leave-lines'
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
import { startThreadStatus } from './thread-status/thread-status-start'
import { connectorAskerImages } from './connector-asker-images'
import { postConnectorAction } from '../connector-cloud/connector-actions'
import { cloudConversation } from '../../shared/connectors/connector-cloud-contract'
import { getAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import type { SlackMirrorCloud } from './slack-mirror-cloud'
import { DeliveryReceipts, type DeliveryReceiptDb } from './external-conversation-delivery-receipts'
import {
  findLinkForSession,
  findLinksForSession,
  type ExternalConversationLinkStore
} from './external-conversation-links'
import { markThreadSeen } from './external-conversation-link-writes'
import { ExternalConversationSeam } from './external-conversation-seam'
import {
  conversationReplyFill,
  journalAskedByOwner,
  type ConversationReplyFill
} from './external-conversation-reply-fill'
import { usageLimitReplyPause } from './external-conversation-reply-pause'
import { liveEmptyTurnRetry } from './external-conversation-reply-empty-retry'
import { ConnectorReplyRecovery } from './external-conversation-reply-recovery'
import { endRestartCutTurns, heldTurnEnds } from './external-conversation-restart-cuts'
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
  store:
    | (ExternalConversationLinkStore & {
        getBots?: () => readonly Bot[]
        flushPendingOrThrowAsync?: RuntimeStore['flushPendingOrThrowAsync']
      })
    | null,
  runtime: {
    getOrchestrationDb: () => DeliveryReceiptDb & OrchestrationDb
    listAutomationRuns: BotConversationActsForSources['listAutomationRuns']
    showAutomation: BotConversationActsForSources['showAutomation']
    onWorktreeLifecycle: (listener: (event: RuntimeWorktreeLifecycleEvent) => void) => () => void
    agentTransitions: Pick<AgentTransitionDetector, 'latestRow' | 'subscribe'>
    onConversationLinked?: () => void
    ensureStructuredAgentSessionHost?: () => Promise<unknown>
    /** Settles once this start continued what the last run cut, naming what it did not. */
    structuredAgentSessionLaunchContinuation?: {
      continued: Promise<{ cutByLastRun: ReadonlySet<string> }>
    }
    getConnectorCloud?: () =>
      | (SlackMirrorCloud & {
          refResolver(): ConnectorRefResolver | null
          orcaAccountName(): string
          repliesFilled(): void
          reply: LeaveLinesCloud['reply']
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
    const lineDeps: Parameters<typeof leaveLines>[0] = {
      store,
      cloud: () => runtime.getConnectorCloud?.() ?? null,
      ...(store.flushPendingOrThrowAsync
        ? { flush: () => store.flushPendingOrThrowAsync!({ drainToStableGeneration: false }) }
        : {}),
      answerPending: (link, turnId) =>
        // At startup the chat host may not be in yet: read the outbox only once it is. A read that
        // fails rejects, so the line tries again rather than going before an answer.
        Promise.resolve(runtime.ensureStructuredAgentSessionHost?.()).then(
          async () =>
            (await getStructuredAgentSessionHost()
              ?.deps.store.connectorReplies()
              ?.unsentAnswer(link.sessionId, link, turnId)) === true
        )
    }
    const lines = installLeaveLines(leaveLines(lineDeps))
    startThreadStatus({ ...lineDeps, store }, () => seam)
    const restartCuts = heldTurnEnds(() => seam)
    seam = new ExternalConversationSeam({
      slackMirror: () => mirror,
      watched: () => {
        mirror?.flushHeld()
        restartCuts.flush()
        // Lines a quit or a reset cut short; a turn still running posts its own as it ends.
        lines.resume((link) => seam?.replyTarget(link.paneKey)?.turnId ?? null)
      },
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
    endRestartCutTurns(
      store,
      runtime.structuredAgentSessionLaunchContinuation,
      seam.signal,
      restartCuts.tell
    )
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
  const usageLimitDisposition = async (sessionId: string, turnItemId: string) =>
    getStructuredAgentSessionHost()?.usageLimitContinue.disposition(sessionId, turnItemId)
  const { retry, settleWith } = liveEmptyTurnRetry(journal, getStructuredAgentSessionHost, signal)
  const fill = conversationReplyFill(
    journal,
    filled,
    usageLimitReplyPause(journal, usageLimitDisposition, async (sessionId) => {
      const shown = await getStructuredAgentSessionHost()?.readUsageLimitContinue(sessionId)
      return shown?.state === 'scheduled' ? (shown.continueAt ?? shown.resetsAt) : undefined
    }),
    journalAskedByOwner(async (sessionId) =>
      getStructuredAgentSessionHost()?.journalReads(sessionId)
    ),
    retry
  )
  const recovery = new ConnectorReplyRecovery({
    journal,
    chat: getStructuredAgentSessionHost,
    hasSession: (sessionId) =>
      getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId) != null,
    isBot: (sessionId) =>
      findLinksForSession(store, sessionId).some(({ link }) => Boolean(link.bot)),
    agentOf: (sessionId) => findLinkForSession(store, sessionId)?.link.agent ?? '',
    fillTurn: fill,
    filled,
    usageLimitDisposition,
    retrySending: retry.sending,
    // This start's own continuations of restart cuts claim first; whatever they left closes then.
    ...(runtime.structuredAgentSessionLaunchContinuation
      ? { continuationsSettled: runtime.structuredAgentSessionLaunchContinuation.continued }
      : {})
  })
  settleWith(recovery)
  setConnectorClaimSource((sessionId, cut) => recovery.claimFor(sessionId, cut))
  let unwatchStatus: (() => void) | undefined
  let unwatchPauses: (() => void) | undefined
  const boot = () => {
    recovery.dispose()
    unwatchStatus?.()
    unwatchPauses?.()
    const host = getStructuredAgentSessionHost()
    // A setting change or a never-loaded chat's close publishes no status: its scheduler says so.
    unwatchPauses = host?.usageLimitContinue.onDispositionChange((id) => recovery.statusChanged(id))
    // Every end of a usage-limit pause publishes the chat's status (its continue's state).
    unwatchStatus = host?.subscribeStatus({
      id: 'connector-reply-pauses',
      emit: (event) => {
        if (event.type === 'status') {
          recovery.statusChanged(event.session.sessionId)
        } else if (event.type === 'snapshot') {
          event.sessions.forEach((session) => recovery.statusChanged(session.sessionId))
        }
      }
    })
    if (host) {
      void recovery.boot()
    }
  }
  const stop = onStructuredAgentSessionHostChanged(boot)
  signal.addEventListener('abort', () => {
    stop()
    unwatchStatus?.()
    unwatchPauses?.()
    setConnectorClaimSource(null)
    recovery.dispose()
  })
  boot()
  return {
    fill: async (turn) => {
      const filledTurn = await fill(turn)
      recovery.turnEnded(turn.sessionId)
      return filledTurn
    },
    admitted: (sessionId) => recovery.admitted(sessionId)
  }
}
