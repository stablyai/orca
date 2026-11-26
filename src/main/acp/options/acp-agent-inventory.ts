import { acpInteractionModeValue, acpSelectChoices } from './acp-select-choices'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import type { AcpDialect } from '../acp-dialects/acp-dialect'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>

export function acpAgentInventory(option: SelectOption | null) {
  return option
    ? {
        agents: acpSelectChoices(option).map((choice) => ({
          id: choice.value,
          label: choice.name,
          ...(choice.description ? { description: choice.description } : {})
        }))
      }
    : {}
}

export function acpAgentWrite(
  option: SelectOption | null,
  value: string
): { method: 'config'; configId: string; value: string } | null {
  return option && acpSelectChoices(option).some((choice) => choice.value === value)
    ? { method: 'config', configId: option.id, value }
    : null
}

export function acpModeWrite(
  key: 'agent' | 'interactionMode',
  value: string,
  dialect: Pick<AcpDialect, 'modeSelectsAgent' | 'interactionModes'>,
  option: SelectOption | null
): { method: 'config'; configId: string; value: string } | null {
  if (key === 'agent') {
    return acpAgentWrite(dialect.modeSelectsAgent ? option : null, value)
  }
  const native = acpInteractionModeValue(dialect.interactionModes, option, value)
  return option && native ? { method: 'config', configId: option.id, value: native } : null
}

export function acpReportedOptions(current: AgentSessionOptionsResult['current']) {
  return {
    ...(current.model ? { model: current.model } : {}),
    ...(current.effort ? { effort: current.effort } : {}),
    ...(current.agent ? { agent: current.agent } : {})
  }
}
