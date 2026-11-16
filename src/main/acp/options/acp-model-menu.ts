import { acpListedModels, acpSelectChoices } from './acp-select-choices'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type {
  AgentSessionModelOption,
  AgentSessionOptionChoice
} from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { SessionConfigOption, SessionModelState } from '../generated/acp-protocol.generated'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

/** Native choices never establish an unobserved model's capability or configured default. */
export function acpModelMenuModels(input: {
  dialect: Pick<AcpDialect, 'modelEfforts' | 'familyEfforts'>
  modelOption: SelectOption | null
  effortOption: SelectOption | null
  state: SessionModelState | null
  currentModel: string | undefined
}): AgentSessionModelOption[] {
  const { dialect, modelOption, effortOption, state, currentModel } = input
  const sessionEfforts: AgentSessionOptionChoice[] = effortOption
    ? acpSelectChoices(effortOption).map((choice) => ({
        value: choice.value,
        label: choice.name,
        ...(choice.description ? { description: choice.description } : {})
      }))
    : []
  return acpListedModels(modelOption, state).map((model) => {
    const info = state?.availableModels.find((entry) => entry.modelId === model.id)
    // The running model's live menu outranks variants advertised for its family.
    const advertised = info
      ? dialect.modelEfforts?.(info)
      : model.id === currentModel
        ? undefined
        : dialect.familyEfforts?.(model.id, state?.availableModels ?? [])
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

/** The agent's Fast option as Orca's toggle, for the running model only. */
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
