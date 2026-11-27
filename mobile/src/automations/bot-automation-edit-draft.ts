// An agent's automation as its phone editor holds it, and the update a save sends, as the desktop's.
import { AutomationBotTarget } from '../../../src/shared/rpc-contract/automation-bot-params'
import type { AutomationBotTarget as BotTarget } from '../../../src/shared/automations/automation-definition'
import type { RpcSendParams } from '../../../src/shared/rpc-contract/rpc-send-params'
import { hasAutomationSchedule } from '../../../src/shared/automation-event-triggers'
import {
  botSchedulePatch,
  isSameBotTarget,
  trimmedBotTarget
} from '../../../src/shared/automations/bot-automation-target-edit'
import type { MobileAutomation } from './automation-reply-schema'

export type BotAutomationDraft = {
  name: string
  prompt: string
  /** Null when this build can't read the saved target; then the save leaves it as it is. */
  target: BotTarget | null
  /** "Only on events" (or "Never" once its events are gone): no schedule. */
  eventsOnly: boolean
  rrule: string
}

/** Its saved target, or null when it isn't one this build can read. */
export function savedBotTarget(automation: MobileAutomation): BotTarget | null {
  const parsed = AutomationBotTarget.safeParse(automation.bot)
  return parsed.success ? parsed.data : null
}

export function botAutomationDraft(automation: MobileAutomation): BotAutomationDraft {
  const eventsOnly = !hasAutomationSchedule(automation)
  return {
    name: automation.name,
    prompt: automation.prompt,
    target: savedBotTarget(automation),
    eventsOnly,
    rrule: eventsOnly ? '0 9 * * 1-5' : automation.rrule
  }
}

export function botAutomationChanged(saved: MobileAutomation, draft: BotAutomationDraft): boolean {
  // Any start time stands in: a schedule's time is sent only when its rule changed.
  return Object.keys(botAutomationUpdates(saved, draft, 0)).length > 0
}

/** What a save sends: only what changed, so a deleted agent's automation can still be renamed. */
export function botAutomationUpdates(
  saved: MobileAutomation,
  draft: BotAutomationDraft,
  now: number
): RpcSendParams<'automation.update'>['updates'] {
  const target = draft.target ? trimmedBotTarget(draft.target) : null
  return {
    ...(draft.name.trim() !== saved.name.trim() ? { name: draft.name.trim() } : {}),
    ...(draft.prompt.trim() !== saved.prompt.trim() ? { prompt: draft.prompt.trim() } : {}),
    ...(target && !isSameBotTarget(savedBotTarget(saved) ?? undefined, target)
      ? { bot: target }
      : {}),
    ...botSchedulePatch(draft.eventsOnly, saved, { rrule: draft.rrule, dtstart: now })
  }
}
