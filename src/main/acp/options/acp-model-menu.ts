import { isAgentSessionInteractionMode } from '../../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import {
  acpEffortOption,
  acpListedModels,
  acpSelectChoices,
  acpSelectOffers,
  acpSelectOption,
  type AcpSelectOption
} from './acp-select-choices'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { AgentSessionOptionChoice } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { SessionConfigOption, SessionModelState } from '../generated/acp-protocol.generated'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

export type AcpOptionWrite =
  | { method: 'config'; configId: string; value: string }
  | { method: 'model'; modelId: string }

function acpFastOption(
  configOptions: readonly SessionConfigOption[],
  fastConfigId: string | undefined
): AcpSelectOption | null {
  const option = fastConfigId ? configOptions.find((entry) => entry.id === fastConfigId) : undefined
  return option?.type === 'select' ? option : null
}

export function buildAcpOptionWrite(input: {
  key: string
  value: string
  configOptions: readonly SessionConfigOption[]
  models: SessionModelState | null
  fastConfigId: string | undefined
  buildMode: string
}): AcpOptionWrite | null {
  const { key, value, configOptions, models, fastConfigId, buildMode } = input
  if (key === 'fastMode') {
    const fast = acpFastOption(configOptions, fastConfigId)
    return fast ? { method: 'config', configId: fast.id, value } : null
  }
  if (key === 'model') {
    const option = acpSelectOption(configOptions, 'model')
    if (option) {
      return { method: 'config', configId: option.id, value }
    }
    return models ? { method: 'model', modelId: value } : null
  }
  if (key === 'effort') {
    const option = acpEffortOption(configOptions)
    return option ? { method: 'config', configId: option.id, value } : null
  }
  if (key === 'interactionMode' && isAgentSessionInteractionMode(value)) {
    const option = acpSelectOption(configOptions, 'mode')
    return option && acpSelectOffers(option, 'plan')
      ? { method: 'config', configId: option.id, value: value === 'plan' ? 'plan' : buildMode }
      : null
  }
  return null
}

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

export function readAcpOptionsMenu(input: {
  configOptions: readonly SessionConfigOption[]
  models: SessionModelState | null
  dialect: Pick<AcpDialect, 'modelEfforts' | 'familyEfforts' | 'fastConfigId'>
  forkSupport: AgentSessionOptionsResult['forkSupport']
}): Pick<AgentSessionOptionsResult, 'models' | 'current' | 'forkSupport' | 'fastModeSupport'> {
  const modelOption = acpSelectOption(input.configOptions, 'model')
  const effortOption = acpEffortOption(input.configOptions)
  const modeOption = acpSelectOption(input.configOptions, 'mode')
  const currentModel = (modelOption?.currentValue ?? input.models?.currentModelId) || undefined
  const interactionMode = acpSelectOffers(modeOption, 'plan')
    ? modeOption?.currentValue === 'plan'
      ? ('plan' as const)
      : ('default' as const)
    : undefined
  const fastOption = acpFastOption(input.configOptions, input.dialect.fastConfigId)
  const menu = {
    models: acpModelMenuModels({
      dialect: input.dialect,
      modelOption,
      effortOption,
      state: input.models,
      currentModel
    }),
    forkSupport: input.forkSupport,
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
  return withFastModeOption(menu, fastOption)
}
