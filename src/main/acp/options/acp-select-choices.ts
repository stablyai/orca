import {
  SessionConfigSelectGroupSchema,
  SessionConfigSelectOptionSchema,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type ModelInfo,
  type SessionModelState
} from '../generated/acp-protocol.generated'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import { isAgentSessionInteractionMode } from '../../../shared/agent-session/options/permissions/agent-session-interaction-mode'

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

function modelInfoChoice(model: ModelInfo) {
  return {
    id: model.modelId,
    label: model.name,
    ...(model.description ? { description: model.description } : {})
  }
}

/** The model select's choices, supplemented only for dialects with an incomplete selector. */
export function acpListedModels(
  modelOption: SelectOption | null,
  models: SessionModelState | null,
  additionalModels?: AcpDialect['additionalModels']
): { id: string; label: string; description?: string }[] {
  if (!modelOption) {
    return models?.availableModels.map(modelInfoChoice) ?? []
  }
  const choices = acpSelectChoices(modelOption).map((choice) => ({
    id: choice.value,
    label: choice.name,
    ...(choice.description ? { description: choice.description } : {})
  }))
  if (!models || !additionalModels) {
    return choices
  }
  const configured = new Set(choices.map(({ id }) => id))
  return [...choices, ...additionalModels(configured, models.availableModels).map(modelInfoChoice)]
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
