import type {
  AvailableCommand,
  SessionConfigOption,
  SessionModeState
} from '@agentclientprotocol/sdk'
import type { StructuredProviderConfiguration } from '../../shared/structured-agent-provider'
import type { SessionOptionDescriptor } from '../../shared/native-chat-session-options'

export function acpConversationConfiguration(input: {
  commands: readonly AvailableCommand[]
  configOptions: readonly SessionConfigOption[]
  modes: SessionModeState | null
  canFork: boolean
}): StructuredProviderConfiguration {
  return {
    commands: input.commands.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.input?.hint ? { inputHint: command.input.hint } : {})
    })),
    options: [
      ...(input.modes ? [modeDescriptor(input.modes)] : []),
      ...input.configOptions.map(configDescriptor)
    ],
    canCompact: input.commands.some((command) => command.name === 'compact'),
    canFork: input.canFork
  }
}

function modeDescriptor(modes: SessionModeState): SessionOptionDescriptor {
  return {
    id: 'mode',
    label: 'Mode',
    category: 'mode',
    kind: {
      type: 'select',
      currentValue: modes.currentModeId,
      choices: modes.availableModes.map((mode) => ({
        value: mode.id,
        label: mode.name,
        ...(mode.description ? { description: mode.description } : {})
      }))
    },
    valueSource: 'reported',
    transport: 'agent-session',
    settable: true
  }
}

function configDescriptor(option: SessionConfigOption): SessionOptionDescriptor {
  const category =
    option.category === 'mode' ||
    option.category === 'model' ||
    option.category === 'model_config' ||
    option.category === 'thought_level'
      ? option.category
      : undefined
  return {
    id: option.id,
    label: option.name,
    ...(option.description ? { description: option.description } : {}),
    ...(category ? { category } : {}),
    kind:
      option.type === 'boolean'
        ? { type: 'boolean', currentValue: option.currentValue }
        : {
            type: 'select',
            currentValue: option.currentValue,
            choices: option.options.flatMap((choice) =>
              'options' in choice ? choice.options.map(selectChoice) : [selectChoice(choice)]
            )
          },
    valueSource: 'reported',
    transport: 'agent-session',
    settable: true
  }
}

function selectChoice(choice: { value: string; name: string; description?: string | null }): {
  value: string
  label: string
  description?: string
} {
  return {
    value: choice.value,
    label: choice.name,
    ...(choice.description ? { description: choice.description } : {})
  }
}
