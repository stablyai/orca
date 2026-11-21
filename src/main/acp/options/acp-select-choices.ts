import {
  SessionConfigSelectGroupSchema,
  SessionConfigSelectOptionSchema,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionModelState
} from '../generated/acp-protocol.generated'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import { isAgentSessionInteractionMode } from '../../../shared/agent-session/options/permissions/agent-session-interaction-mode'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

/** A grouped select lists choices per provider; keeping the group name is what tells two of them apart. */
export function acpSelectChoiceGroups(
  option: SelectOption
): { choice: SessionConfigSelectOption; group: string | null }[] {
  const grouped: { choice: SessionConfigSelectOption; group: string | null }[] = []
  for (const entry of option.options) {
    const group = SessionConfigSelectGroupSchema.safeParse(entry)
    if (group.success) {
      for (const choice of group.data.options) {
        grouped.push({ choice, group: group.data.name })
      }
      continue
    }
    const choice = SessionConfigSelectOptionSchema.safeParse(entry)
    if (choice.success) {
      grouped.push({ choice: choice.data, group: null })
    }
  }
  return grouped
}

export function acpSelectChoices(option: SelectOption): SessionConfigSelectOption[] {
  return acpSelectChoiceGroups(option).map(({ choice }) => choice)
}

/** The model select's choices, or the legacy model list when the agent offers no select. */
export function acpListedModels(
  modelOption: SelectOption | null,
  models: SessionModelState | null
): { id: string; label: string; description?: string }[] {
  if (!modelOption) {
    return (
      models?.availableModels.map((model) => ({
        id: model.modelId,
        label: model.name,
        ...(model.description ? { description: model.description } : {})
      })) ?? []
    )
  }
  const grouped = acpSelectChoiceGroups(modelOption)
  const labelCounts = new Map<string, number>()
  for (const { choice } of grouped) {
    labelCounts.set(choice.name, (labelCounts.get(choice.name) ?? 0) + 1)
  }
  return grouped.map(({ choice, group }) => ({
    id: choice.value,
    // Providers offer the same model under one name, so the provider joins the label only where the name repeats.
    label:
      group && (labelCounts.get(choice.name) ?? 0) > 1 ? `${choice.name} (${group})` : choice.name,
    ...(choice.description ? { description: choice.description } : {})
  }))
}

/** The options with a mode the agent reported apart from them; null when it lists no mode select. */
export function acpWithCurrentMode(
  options: readonly SessionConfigOption[],
  modeId: string
): SessionConfigOption[] | null {
  const isMode = (option: SessionConfigOption): option is SelectOption =>
    option.category === 'mode' && option.type === 'select'
  return options.some(isMode)
    ? options.map((option) => (isMode(option) ? { ...option, currentValue: modeId } : option))
    : null
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

/** The agent's own mode value for Orca's interaction mode, when its mode select offers it. */
export function acpInteractionModeValue(
  interactionModes: AcpDialect['interactionModes'],
  modeOption: SelectOption | null,
  value: string
): string | null {
  const native = isAgentSessionInteractionMode(value) ? interactionModes?.[value] : undefined
  return native &&
    modeOption &&
    acpSelectChoices(modeOption).some((choice) => choice.value === native)
    ? native
    : null
}
