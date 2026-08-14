import type { SDKControlInitializeResponse } from '@anthropic-ai/claude-agent-sdk'
import type { StructuredProviderConfiguration } from '../../shared/structured-agent-provider'

export function claudeConversationConfiguration(
  initialization: SDKControlInitializeResponse
): StructuredProviderConfiguration {
  return {
    commands: initialization.commands.map((command) => ({
      name: command.name,
      description: command.description,
      inputHint: command.argumentHint
    })),
    canCompact: initialization.commands.some((command) => command.name === 'compact'),
    canFork: true,
    options: [
      {
        id: 'model',
        label: 'Model',
        category: 'model',
        kind: {
          type: 'select',
          choices: initialization.models.map((model) => ({
            value: model.value,
            label: model.displayName,
            description: model.description
          }))
        },
        valueSource: 'unknown',
        transport: 'agent-session',
        settable: true
      },
      {
        id: 'effort',
        label: 'Reasoning',
        category: 'thought_level',
        kind: {
          type: 'select',
          choices: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
            value,
            label: value
          }))
        },
        valueSource: 'unknown',
        transport: 'agent-session',
        settable: true
      }
    ]
  }
}
