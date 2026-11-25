// Whom a bot conversation acts for, as every check reads it: Orca's record, less the unknown causer an
// event run recorded before runs acted for their creator alone, when its automation proves that safe.
import type { Automation } from '../../shared/automations/automation-definition'
import type { AutomationRun } from '../../shared/automations/history/automation-run'
import type { BotRequestAsker } from '../../shared/bots/bot-acts-for'
import type { BotConversationActsFor } from '../runtime/orchestration/db/bot-requests/bot-conversation-acts-for-store'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'

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
  const recorded = sources.getOrchestrationDb().getBotConversationActsFor(root)
  // An old event run's row: its triggered_by names no event kind, and it holds the causer beside its creator.
  const legacyEventRun =
    recorded?.triggeredBy !== undefined &&
    !recorded.triggeredBy.event &&
    recorded.actsFor.some(isUnknown) &&
    !recorded.actsFor.every(isUnknown)
  if (!recorded || !legacyEventRun) {
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
