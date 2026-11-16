import type { AcpDialect } from '../acp-dialects/acp-dialect'
import type { SessionConfigOption } from '../generated/acp-protocol.generated'
import type { AgentSessionOptionsResult } from '../../../shared/agent-session/options/protocol/agent-session-options-result'
import { isAgentSessionInteractionMode } from '../../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import { acpSelectChoices } from './acp-select-choices'
import type { AcpOptionWrite } from './acp-structured-options'

type SelectOption = Extract<SessionConfigOption, { type: 'select' }>
type ModeMapping = AcpDialect['interactionModes']

export function acpInteractionModeWrite(
  mapping: ModeMapping,
  option: SelectOption | null,
  value: string
): AcpOptionWrite | null {
  const native = isAgentSessionInteractionMode(value) ? mapping?.[value] : undefined
  return option && native && acpSelectChoices(option).some((choice) => choice.value === native)
    ? { method: 'config', configId: option.id, value: native }
    : null
}

export function acpInteractionModeSnapshot(
  mapping: ModeMapping,
  option: SelectOption | null,
  known: boolean
): Pick<AgentSessionOptionsResult, 'interactionModes' | 'current'> {
  const id = mapping ? option?.currentValue : undefined
  return {
    ...(mapping && known
      ? {
          interactionModes: (['default', 'plan'] as const).filter(
            (mode) => acpInteractionModeWrite(mapping, option, mode) !== null
          )
        }
      : {}),
    current:
      id && option
        ? {
            reportedAgent: {
              id,
              name: acpSelectChoices(option).find((choice) => choice.value === id)?.name || id
            }
          }
        : {}
  }
}

export function withAcpCurrentMode(
  mapping: ModeMapping,
  configOptions: SessionConfigOption[],
  modeId: string
): SessionConfigOption[] | undefined {
  const option = mapping ? configOptions.find((entry) => entry.category === 'mode') : undefined
  return option?.type === 'select'
    ? configOptions.map((entry) => (entry === option ? { ...option, currentValue: modeId } : entry))
    : undefined
}

export function withAcpObservedMode(
  snapshot: SessionConfigOption[],
  observed: SessionConfigOption[]
): SessionConfigOption[] {
  const mode = observed.find((option) => option.category === 'mode')
  const options = snapshot.filter((option) => option.category !== 'mode')
  return mode ? [...options, mode] : options
}
