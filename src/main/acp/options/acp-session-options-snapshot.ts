import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { SessionConfigOption, SessionModelState } from '../generated/acp-protocol.generated'
import { acpInteractionModeSnapshot } from './acp-interaction-mode'
import { acpModelMenuModels, withFastModeOption } from './acp-model-menu'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

export function acpReportedModelOptions(
  current: AgentSessionOptionsResult['current']
): Readonly<Record<string, string>> {
  return {
    ...(current.model ? { model: current.model } : {}),
    ...(current.effort ? { effort: current.effort } : {})
  }
}

export function acpSessionOptionsSnapshot(input: {
  dialect: Pick<AcpDialect, 'modelEfforts' | 'familyEfforts' | 'interactionModes'>
  modelOption: SelectOption | null
  effortOption: SelectOption | null
  modeOption: SelectOption | null
  models: SessionModelState | null
  configOptionsKnown: boolean
  forkSupport: AgentSessionOptionsResult['forkSupport']
  fast: SelectOption | null
}): Pick<
  AgentSessionOptionsResult,
  'models' | 'current' | 'forkSupport' | 'fastModeSupport' | 'interactionModes'
> {
  const { modelOption, effortOption } = input
  const currentModel = (modelOption?.currentValue ?? input.models?.currentModelId) || undefined
  const models = acpModelMenuModels({
    dialect: input.dialect,
    modelOption,
    effortOption,
    state: input.models,
    currentModel
  })
  const interaction = acpInteractionModeSnapshot(
    input.dialect.interactionModes,
    input.modeOption,
    input.configOptionsKnown
  )
  return withFastModeOption(
    {
      models,
      forkSupport: input.forkSupport,
      ...interaction,
      current: {
        ...(currentModel ? { model: currentModel } : {}),
        ...(effortOption ? { effort: effortOption.currentValue } : {}),
        ...interaction.current,
        confirmed: [...(currentModel ? ['model'] : []), ...(effortOption ? ['effort'] : [])]
      }
    },
    input.fast
  )
}
