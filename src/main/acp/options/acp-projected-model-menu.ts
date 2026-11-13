import type { AcpDialect } from '../acp-dialects/acp-dialect'
import { acpSelectChoices } from './acp-select-choices'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/agent-session-options-result'
import type { SessionConfigOption, SessionModelState } from '../generated/acp-protocol.generated'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

export function flatAcpModelMenu(input: {
  dialect: Pick<AcpDialect, 'modelEfforts'>
  modelOption: SelectOption | null
  effortOption: SelectOption | null
  availableModels: SessionModelState['availableModels'] | undefined
  currentModel: string | undefined
  currentEffort: string | undefined
  forkSupport: AgentSessionOptionsResult['forkSupport']
}): Pick<AgentSessionOptionsResult, 'models' | 'current' | 'forkSupport' | 'fastModeSupport'> {
  const sessionEfforts: AgentSessionOptionChoice[] = input.effortOption
    ? acpSelectChoices(input.effortOption).map((choice) => ({
        value: choice.value,
        label: choice.name,
        ...(choice.description ? { description: choice.description } : {})
      }))
    : []
  const listed: { id: string; label: string; description?: string }[] = input.modelOption
    ? acpSelectChoices(input.modelOption).map((choice) => ({
        id: choice.value,
        label: choice.name,
        ...(choice.description ? { description: choice.description } : {})
      }))
    : (input.availableModels?.map((model) => ({
        id: model.modelId,
        label: model.name,
        ...(model.description ? { description: model.description } : {})
      })) ?? [])
  const models: AgentSessionModelOption[] = listed.map((model) => {
    const info = input.availableModels?.find((entry) => entry.modelId === model.id)
    const advertised = info ? input.dialect.modelEfforts?.(info) : undefined
    // A current-session menu supplies no negative evidence about an unobserved model.
    const sessionMenu =
      model.id === input.currentModel
        ? { efforts: sessionEfforts }
        : (input.modelOption || input.effortOption) && !advertised
          ? { efforts: [], effortsKnown: false as const }
          : { efforts: [] }
    return {
      ...model,
      isDefault: false,
      ...(advertised && (advertised.efforts.length > 0 || model.id !== input.currentModel)
        ? advertised
        : sessionMenu),
      ...(advertised?.declaredDefaultEffort !== undefined
        ? { declaredDefaultEffort: advertised.declaredDefaultEffort }
        : {})
    }
  })
  return {
    models,
    forkSupport: input.forkSupport,
    current: {
      ...(input.currentModel ? { model: input.currentModel } : {}),
      ...(input.currentEffort ? { effort: input.currentEffort } : {}),
      confirmed: [
        ...(input.currentModel ? ['model'] : []),
        ...(input.effortOption ? ['effort'] : [])
      ]
    }
  }
}

export function withFastModeOption<T extends Pick<AgentSessionOptionsResult, 'models' | 'current'>>(
  menu: T,
  fast: { currentValue: string } | null
): T & Pick<AgentSessionOptionsResult, 'fastModeSupport'> {
  if (!fast) {
    return menu
  }
  return {
    ...menu,
    fastModeSupport: { supported: true },
    models: menu.models.map((model) =>
      model.id === menu.current.model ? { ...model, supportsFastMode: true } : model
    ),
    current: {
      ...menu.current,
      fastMode: fast.currentValue === 'true',
      confirmed: [...(menu.current.confirmed ?? []), 'fastMode']
    }
  }
}
