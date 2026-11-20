import type {
  Automation,
  AutomationCreateInput
} from '../../../shared/automations/automation-definition'

/** The bot target, event triggers, wait and explicit zone a new automation keeps, each only when set. */
export function botAndTriggerFields(
  input: AutomationCreateInput
): Pick<Automation, 'bot' | 'on' | 'once' | 'timezoneExplicit'> {
  return {
    ...(input.bot ? { bot: input.bot } : {}),
    ...(input.on?.length ? { on: input.on } : {}),
    ...(input.once ? { once: input.once } : {}),
    ...(input.timezoneExplicit ? { timezoneExplicit: true } : {})
  }
}
