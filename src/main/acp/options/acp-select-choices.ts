import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import {
  SessionConfigSelectGroupSchema,
  SessionConfigSelectOptionSchema,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionModelState
} from '../generated/acp-protocol.generated'

export type AcpSelectOption = Extract<SessionConfigOption, { type: 'select' }>

export function acpSelectOption(
  configOptions: readonly SessionConfigOption[],
  category: string
): AcpSelectOption | null {
  const option = configOptions.find(
    (entry) => entry.category === category || (category === 'model' && entry.id === 'model')
  )
  return option?.type === 'select' ? option : null
}

export function acpSelectChoices(option: AcpSelectOption): SessionConfigSelectOption[] {
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
  modelOption: AcpSelectOption | null,
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

export function acpSelectOffers(option: AcpSelectOption | null, value: string): boolean {
  return !!(option && acpSelectChoices(option).some((choice) => choice.value === value))
}

export function readAcpSessionOptions(input: {
  configOptions: readonly SessionConfigOption[]
  models: SessionModelState | null
  dialect: Pick<AcpDialect, 'modelEfforts' | 'familyEfforts'>
}): Pick<AgentSessionOptionsResult, 'models' | 'current'> {
  const modelOption = acpSelectOption(input.configOptions, 'model')
  const effortOption = acpSelectOption(input.configOptions, 'thought_level')
  const modeOption = acpSelectOption(input.configOptions, 'mode')
  const currentModel = (modelOption?.currentValue ?? input.models?.currentModelId) || undefined
  const interactionMode = acpSelectOffers(modeOption, 'plan')
    ? modeOption?.currentValue === 'plan'
      ? ('plan' as const)
      : ('default' as const)
    : undefined
  return {
    models: projectAcpModelOptions({
      modelOption,
      effortOption,
      models: input.models,
      currentModel,
      dialect: input.dialect
    }),
    current: {
      ...(currentModel ? { model: currentModel } : {}),
      ...(effortOption ? { effort: effortOption.currentValue } : {}),
      ...(interactionMode ? { interactionMode } : {}),
      confirmed: [
        ...(currentModel ? ['model'] : []),
        ...(effortOption ? ['effort'] : []),
        ...(interactionMode ? ['interactionMode'] : [])
      ]
    }
  }
}

/** Native choices never establish an unobserved model's capability or configured default. */
export function projectAcpModelOptions(input: {
  modelOption: AcpSelectOption | null
  effortOption: AcpSelectOption | null
  models: SessionModelState | null
  currentModel: string | undefined
  dialect: Pick<AcpDialect, 'modelEfforts' | 'familyEfforts'>
}): AgentSessionModelOption[] {
  const { modelOption, effortOption, models, currentModel, dialect } = input
  const sessionEfforts: AgentSessionOptionChoice[] = effortOption
    ? acpSelectChoices(effortOption).map((choice) => ({
        value: choice.value,
        label: choice.name,
        ...(choice.description ? { description: choice.description } : {})
      }))
    : []
  return acpListedModels(modelOption, models).map((model) => {
    const info = models?.availableModels.find((entry) => entry.modelId === model.id)
    // The running model's live menu outranks variants advertised for its family.
    const advertised = info
      ? dialect.modelEfforts?.(info)
      : model.id === currentModel
        ? undefined
        : dialect.familyEfforts?.(model.id, models?.availableModels ?? [])
    // A current-session menu supplies no negative evidence about an unobserved model.
    const sessionMenu =
      model.id === currentModel
        ? { efforts: sessionEfforts }
        : (modelOption || effortOption) && !advertised
          ? { efforts: [], effortsKnown: false as const }
          : { efforts: [] }
    return {
      ...model,
      isDefault: false,
      // Fall back to the running session's menu when the advertised menu is empty.
      ...(advertised && (advertised.efforts.length > 0 || model.id !== currentModel)
        ? advertised
        : sessionMenu),
      ...(advertised?.declaredDefaultEffort !== undefined
        ? { declaredDefaultEffort: advertised.declaredDefaultEffort }
        : {})
    }
  })
}
