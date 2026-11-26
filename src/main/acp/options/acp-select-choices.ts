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

export function acpIdSelect(
  options: SessionConfigOption[],
  id: string | undefined
): SelectOption | null {
  const option = id ? options.find((entry) => entry.id === id) : undefined
  return option?.type === 'select' ? option : null
}

export function acpCategorySelect(
  options: SessionConfigOption[],
  category: string
): SelectOption | null {
  const option = options.find(
    (entry) => entry.category === category || (category === 'model' && entry.id === 'model')
  )
  return option?.type === 'select' ? option : null
}

export function acpToggleWrite(
  options: SessionConfigOption[],
  id: string | undefined,
  value: string
): { method: 'config'; configId: string; value: string } | null {
  const option = acpIdSelect(options, id)
  return option ? { method: 'config', configId: option.id, value } : null
}

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

/** The model select's choices, or the legacy model list when the agent offers no select. */
export function acpListedModels(
  modelOption: SelectOption | null,
  models: SessionModelState | null
): { id: string; label: string; description?: string }[] {
  return modelOption
    ? acpSelectChoices(modelOption).map((choice) => ({
        id: choice.value,
        label: choice.name,
        ...(choice.description ? { description: choice.description } : {})
      }))
    : (models?.availableModels.map((model) => ({
        id: model.modelId,
        label: model.name,
        ...(model.description ? { description: model.description } : {})
      })) ?? [])
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

export function acpOffersEffort(
  option: SelectOption | null,
  value: string,
  clampsUnlisted: boolean | undefined
): boolean {
  return !!(
    option &&
    (clampsUnlisted || acpSelectChoices(option).some((choice) => choice.value === value))
  )
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

export function acpNeedsInteractionMode(
  modes: AcpDialect['interactionModes'],
  option: SelectOption | null,
  applied: string | undefined,
  value: string
): boolean {
  const native = acpInteractionModeValue(modes, option, value)
  return native ? applied !== value || option?.currentValue !== native : value === 'plan'
}

export function acpReportedPermissionMode(
  values: Readonly<Partial<Record<string, string>>> | undefined,
  current: string | undefined,
  applied: string | undefined
): string | null {
  if (!values) {
    return applied ?? null
  }
  return current
    ? (Object.entries(values).find(([, value]) => value === current)?.[0] ?? null)
    : null
}
