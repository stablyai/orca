// Whom a bot conversation acts for, as every check reads it: Orca's record, less the unknown causer an
// event run recorded before runs acted for their creator alone, when its automation proves that safe.
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotConversationActsFor } from '../runtime/orchestration/db/bot-requests/bot-conversation-acts-for-store'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { Bot } from '../../shared/bot-types'
import type { AutomationBotTarget } from '../../shared/automation-bot-target'
import {
  automationHomeOf,
  botHomeOfActsFor,
  botHomeOpenable,
  botHomePlaceholderAccount,
  type BotHomeOf
} from '../../shared/bots/bot-home-of'
import { createChatOrcaSessionIdResolver } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'

export type BotConversationActsForSources = {
  getOrchestrationDb: () => OrchestrationDb
  listAutomationRuns: () => AutomationRun[]
  /** Throws when the automation is gone. */
  showAutomation: (id: string) => Automation
}

const isUnknown = (asker: BotRequestAsker) => asker.kind === 'unknown'

/** `root` is the conversation's /clear root, which its record is keyed by. */
export function readBotConversationActsFor(
  sources: BotConversationActsForSources,
  root: string
): BotConversationActsFor | undefined {
  return readBotConversationActsForMany(sources, [root]).get(root)
}

/** Many roots' records in one database read; one without a record is absent. */
function readBotConversationActsForMany(
  sources: BotConversationActsForSources,
  roots: readonly string[]
): Map<string, BotConversationActsFor> {
  const recorded = sources.getOrchestrationDb().listBotConversationActsFor(roots)
  for (const [root, record] of recorded) {
    recorded.set(root, withoutLegacyRunUnknown(sources, root, record))
  }
  return recorded
}

function withoutLegacyRunUnknown(
  sources: BotConversationActsForSources,
  root: string,
  recorded: BotConversationActsFor
): BotConversationActsFor {
  // An old event run's row: its triggered_by names no event kind, and it holds the causer beside its creator.
  const legacyEventRun =
    recorded.triggeredBy !== undefined &&
    !recorded.triggeredBy.event &&
    recorded.actsFor.some(isUnknown) &&
    !recorded.actsFor.every(isUnknown)
  if (!legacyEventRun) {
    return recorded
  }
  // The unknown goes while the run's automation still exists: it acts for the owner.
  return legacyRunAutomationExists(sources, root)
    ? { ...recorded, actsFor: recorded.actsFor.filter((asker) => !isUnknown(asker)) }
    : recorded
}

function legacyRunAutomationExists(sources: BotConversationActsForSources, root: string): boolean {
  try {
    const run = sources.listAutomationRuns().find((entry) => entry.chatSessionId === root)
    return run !== undefined && sources.showAutomation(run.automationId) !== undefined
  } catch {
    return false
  }
}

/** Whose Home a chat's mail falls back to: the teammate it acts for alone, else the owner. Takes any
 *  session of the chat; the record is keyed by its /clear root. */
export function botHomeOfChat(
  sources: BotConversationActsForSources,
  bot: Pick<Bot, 'shares'>,
  sessionId: string
): BotHomeOf {
  const root = createChatOrcaSessionIdResolver()(sessionId)
  return botHomesOfChats(sources, bot, [root]).get(root) ?? 'owner'
}

/** Whose Home each chat (by /clear root) falls under, in one database read: a teammate's Home row not
 *  made yet is theirs while they may have one; any other chat is the teammate it acts for alone, else
 *  the owner's. */
export function botHomesOfChats(
  sources: BotConversationActsForSources,
  bot: Pick<Bot, 'shares'>,
  roots: readonly string[]
): Map<string, BotHomeOf> {
  const recorded = readBotConversationActsForMany(sources, roots)
  return new Map(
    roots.map((root): [string, BotHomeOf] => {
      const placeholder = botHomePlaceholderAccount(root)
      if (placeholder !== null) {
        const of = { accountId: placeholder }
        return [root, botHomeOpenable(bot, of) ? of : 'owner']
      }
      const record = recorded.get(root)
      return [root, record ? botHomeOfActsFor(bot, record.actsFor) : 'owner']
    })
  )
}

/** Whose Home an automation's "chat" runs and results use. */
export function automationHome(
  sources: BotConversationActsForSources,
  bot: Pick<Bot, 'shares'>,
  target: Pick<AutomationBotTarget, 'home' | 'chat'> | undefined
): BotHomeOf {
  return target
    ? automationHomeOf(target, (sessionId) => botHomeOfChat(sources, bot, sessionId))
    : 'owner'
}
