// Cross-agent failover handoff for a bot session: preserves actsFor, connector links, queued mail and watchers.
import { randomUUID } from 'node:crypto'
import type { Bot, BotAgent } from '../../shared/bot-types'
import { backupEntryToLaunch, type BotBackupModelEntry } from '../../shared/bots/bot-backup-models'
import { botOnSetup } from '../../shared/bots/bot-agent-setup'
import { buildAgentSessionContinuationPrompt } from '../../shared/agent-session/conversation-context/agent-session-continuation'
import { agentSessionSendBodyFingerprint } from '../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import { redactSecretLike } from '../../shared/crash-reporting/crash-report-redaction'
import type { AgentJournalBotBackupModelSwitchItem } from '../../shared/agent-journal-orca-card-items'
import type { BotConversationActsFor } from '../runtime/orchestration/db/bot-requests/bot-conversation-acts-for-store'
import type { ExternalConversationLinkStore } from '../external-conversations/external-conversation-links'
import {
  findLinksForSession,
  writeLink
} from '../external-conversations/external-conversation-links'
import type { AgentSessionContinuationContext } from '../../shared/agent-session/agent-session-wire'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'

const MAX_HANDOFF_EXCERPT_CHARS = 24_000

export type BotCrossAgentHandoffInput = {
  bot: Bot
  sourceSessionId: string
  sourceAgent: BotAgent
  sourceModel?: string
  target: BotBackupModelEntry
  direction: 'to-backup' | 'to-primary'
  returnReason?: 'limit-reset' | 'manual'
  resetsAt?: number
  now: number
}

export type BotCrossAgentHandoffSend = {
  sessionId: string
  clientMessageId: string
  fingerprint: string
}

export type BotCrossAgentHandoffResult = {
  newSessionId: string
  switchId: string
}

export type BotCrossAgentHandoffDeps = {
  readContinuationContext: (
    sessionId: string,
    workspaceId: string
  ) => Promise<AgentSessionContinuationContext | null>
  readConversationName: (sessionId: string) => string | undefined
  isBackgroundSession: (sessionId: string) => boolean
  isTabVisible: (sessionId: string) => boolean
  readActsFor: (sessionId: string) => BotConversationActsFor | null
  startSession: (
    botOnTarget: Bot,
    input: {
      sessionId: string
      background?: true
      actsFor?: BotConversationActsFor
      text: string
      clientMessageId: string
    }
  ) => Promise<string>
  setHomeChatSession: (botId: string, sessionId: string) => Promise<void>
  carryQueuedMessages: (fromSessionId: string, toSessionId: string) => Promise<void>
  closeOldHomeChat: (sessionId: string) => Promise<void>
  showTab: (bot: Bot, sessionId: string) => Promise<void>
  nameSession: (sessionId: string, name: string) => Promise<void>
  appendSwitchCard: (
    sessionId: string,
    item: AgentJournalBotBackupModelSwitchItem,
    at: number
  ) => Promise<void>
  linkStore: () => ExternalConversationLinkStore | null
  onSessionHandedOff?: (
    fromSessionId: string,
    toSessionId: string,
    handoffSend?: BotCrossAgentHandoffSend
  ) => void
}

/** Builds a bounded, secret-redacted continuation prompt for cross-agent backup failover. */
export function buildBotFailoverHandoffPrompt(input: {
  sourceAgent: BotAgent
  direction: 'to-backup' | 'to-primary'
  context: AgentSessionContinuationContext | null
}): string {
  const lead =
    input.direction === 'to-backup'
      ? 'You are seamlessly taking over this bot conversation because the previous model hit its usage limit. Continue where the previous turn stopped without repeating completed work.'
      : 'You are resuming this bot conversation on its primary model now that its usage limit has reset. Continue seamlessly without repeating completed work.'
  if (!input.context || input.context.status !== 'current') {
    return `${lead}\n\nContinue where you left off.`
  }
  const safeCaptured = redactSecretLike(input.context.capturedText ?? '').slice(
    -MAX_HANDOFF_EXCERPT_CHARS
  )
  const prompt = buildAgentSessionContinuationPrompt(
    {
      sourceKind: 'chat',
      sourceAgent: isTuiAgent(input.sourceAgent) ? input.sourceAgent : null,
      capturedText: safeCaptured
    },
    'focused'
  )
  return prompt ? `${lead}\n\n${prompt}` : `${lead}\n\nContinue where you left off.`
}

export async function executeCrossAgentBotHandoff(
  deps: BotCrossAgentHandoffDeps,
  input: BotCrossAgentHandoffInput
): Promise<BotCrossAgentHandoffResult> {
  const {
    bot,
    sourceSessionId,
    sourceAgent,
    sourceModel,
    target,
    direction,
    returnReason,
    resetsAt,
    now
  } = input
  const workspaceId = folderWorkspaceKey(bot.folderWorkspaceId)
  const isHomeChat = bot.chatSessionId === sourceSessionId
  const wasVisible = deps.isTabVisible(sourceSessionId)
  const background = !isHomeChat && deps.isBackgroundSession(sourceSessionId)
  const conversationName = deps.readConversationName(sourceSessionId)
  // Preserve original authority verbatim so a non-owner connector requester can never escalate.
  const actsFor = deps.readActsFor(sourceSessionId) ?? undefined
  const context = await deps.readContinuationContext(sourceSessionId, workspaceId).catch(() => null)
  const prompt = buildBotFailoverHandoffPrompt({
    sourceAgent,
    direction,
    context
  })

  const newSessionId = randomUUID()
  const switchId = randomUUID()
  const clientMessageId = `backup-handoff:${switchId}`
  const handoffSend: BotCrossAgentHandoffSend = {
    sessionId: newSessionId,
    clientMessageId,
    fingerprint: agentSessionSendBodyFingerprint(newSessionId, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: prompt }]
    })
  }
  const targetLaunch = backupEntryToLaunch(target)
  const botOnTarget = botOnSetup(bot, {
    agent: target.agent,
    ...(targetLaunch ? { launch: targetLaunch } : {})
  })

  // Rebind connector links before startSession so early mirrored events on newSessionId find their link.
  const store = deps.linkStore()
  const reboundLinks = store
    ? findLinksForSession(store, sourceSessionId).filter(
        (linked) => linked.link.bot?.kind !== 'bot-chat'
      )
    : []
  if (store) {
    for (const linked of reboundLinks) {
      writeLink(store, linked.workspace, {
        ...linked.link,
        sessionId: newSessionId,
        agent: target.agent,
        paneKey: `chat:${newSessionId}`
      })
    }
  }

  try {
    await deps.startSession(botOnTarget, {
      sessionId: newSessionId,
      ...(background ? { background: true as const } : {}),
      ...(actsFor ? { actsFor } : {}),
      text: prompt,
      clientMessageId
    })
  } catch (error) {
    if (store) {
      for (const linked of reboundLinks) {
        writeLink(store, linked.workspace, linked.link)
      }
    }
    throw error
  }

  if (conversationName) {
    await deps.nameSession(newSessionId, conversationName).catch(() => {})
  }

  // Migrate queued messages before switching or closing the source so failed migration stays recoverable.
  await deps.carryQueuedMessages(sourceSessionId, newSessionId)

  if (isHomeChat) {
    await deps.setHomeChatSession(bot.id, newSessionId)
    if (wasVisible) {
      await deps.showTab(botOnTarget, newSessionId).catch(() => {})
    }
    await deps.closeOldHomeChat(sourceSessionId).catch(() => {})
  } else if (wasVisible) {
    await deps.showTab(botOnTarget, newSessionId).catch(() => {})
  }

  const baseCard: Omit<AgentJournalBotBackupModelSwitchItem, 'linkedSessionId'> = {
    kind: 'bot-backup-model-switch',
    switchId,
    botId: bot.id,
    direction,
    ...(returnReason ? { returnReason } : {}),
    fromAgent: sourceAgent,
    ...(sourceModel ? { fromModel: sourceModel } : {}),
    toAgent: target.agent,
    ...(target.model ? { toModel: target.model } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    at: now
  }
  await Promise.allSettled([
    deps.appendSwitchCard(sourceSessionId, { ...baseCard, linkedSessionId: newSessionId }, now),
    deps.appendSwitchCard(newSessionId, { ...baseCard, linkedSessionId: sourceSessionId }, now)
  ])

  deps.onSessionHandedOff?.(sourceSessionId, newSessionId, handoffSend)
  return { newSessionId, switchId }
}
