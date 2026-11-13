import {
  SessionConfigSelectGroupSchema,
  SessionConfigSelectOptionSchema,
  type SessionConfigOption,
  type SessionConfigSelectOption
} from '../generated/acp-protocol.generated'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

export function acpSelectChoices(option: SelectOption): SessionConfigSelectOption[] {
  const choices: SessionConfigSelectOption[] = []
  for (const entry of option.options) {
    const group = SessionConfigSelectGroupSchema.safeParse(entry)
    if (group.success) {
      choices.push(...group.data.options)
      continue
    }
    const choice = SessionConfigSelectOptionSchema.safeParse(entry)
    if (choice.success) {
      choices.push(choice.data)
    }
  }
  return choices
}

/** An agent may list an on/off thinking switch beside its effort levels; effort is the longer menu. */
export function acpEffortOption(options: readonly SessionConfigOption[]): SelectOption | null {
  let effort: SelectOption | null = null
  for (const option of options) {
    if (
      option.category === 'thought_level' &&
      option.type === 'select' &&
      (!effort || acpSelectChoices(option).length > acpSelectChoices(effort).length)
    ) {
      effort = option
    }
  }
  return effort
}
