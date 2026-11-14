import {
  SessionConfigSelectGroupSchema,
  SessionConfigSelectOptionSchema,
  type SessionConfigOption,
  type SessionConfigSelectOption,
  type SessionModelState
} from '../generated/acp-protocol.generated'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session/agent-session-wire'
import type { AcpDialect } from '../acp-dialects/acp-dialect'

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

export function acpListedModels(params: {
  modelOption: SelectOption | null
  effortOption: SelectOption | null
  sessionEfforts: AgentSessionOptionChoice[]
  currentModel: string | undefined
  models: SessionModelState | null
  dialect: Pick<AcpDialect, 'modelEfforts' | 'groupedModelEfforts'>
}): AgentSessionModelOption[] {
  const { modelOption, effortOption, sessionEfforts, currentModel, models, dialect } = params
  const listed: { id: string; label: string; description?: string }[] = modelOption
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
  return listed.map((model) => {
    const info = models?.availableModels.find((entry) => entry.modelId === model.id)
    const advertised =
      (info ? dialect.modelEfforts?.(info) : undefined) ??
      (models?.availableModels.length && !(model.id === currentModel && sessionEfforts.length > 0)
        ? dialect.groupedModelEfforts?.(model.id, models.availableModels)
        : undefined)
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
