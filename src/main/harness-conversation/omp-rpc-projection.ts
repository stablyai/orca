import { randomUUID } from 'node:crypto'
import { isRecord } from '../../shared/agent-status-child-work-value-guards'
import type { AgentSessionContextSnapshot } from '../../shared/agent-session-context'
import type { StructuredProviderConfiguration } from '../../shared/structured-agent-provider'
import type { NativeChatMessage } from '../../shared/native-chat-types'
import { providerImageData } from './provider-image-input'
import type { OmpRpcFrame } from './omp-rpc-connection'

export type OmpCommand = { name: string; description?: string; inputHint?: string }

export function ompPrompt(text: string, imagePaths?: readonly string[]): Record<string, unknown> {
  return {
    message: text,
    images: (imagePaths ?? []).map((path) => {
      const image = providerImageData(path)
      return { type: 'image', data: image.data, mimeType: image.mediaType }
    })
  }
}

export function parseOmpCommands(data: unknown): OmpCommand[] {
  const commands = isRecord(data) ? data.commands : undefined
  if (!Array.isArray(commands)) {
    return []
  }
  return commands.flatMap((command) => {
    if (!isRecord(command)) {
      return []
    }
    const value = command
    if (typeof value.name !== 'string') {
      return []
    }
    const input = isRecord(value.input) ? value.input : undefined
    return [
      {
        name: value.name,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(typeof input?.hint === 'string' ? { inputHint: input.hint } : {})
      }
    ]
  })
}

export function parseOmpModels(data: unknown): { label: string; value: string }[] {
  const models = isRecord(data) ? data.models : undefined
  if (!Array.isArray(models)) {
    return []
  }
  return models.flatMap((model) => {
    if (!isRecord(model)) {
      return []
    }
    const value = model
    return typeof value.provider === 'string' && typeof value.id === 'string'
      ? [
          {
            label: typeof value.name === 'string' ? value.name : value.id,
            value: `${value.provider}/${value.id}`
          }
        ]
      : []
  })
}

export function ompContext(
  data: unknown,
  model: string,
  effort: string
): AgentSessionContextSnapshot | null {
  const usage = isRecord(data) ? data.contextUsage : undefined
  if (!isRecord(usage)) {
    return null
  }
  const { tokens, contextWindow } = usage
  if (
    typeof tokens !== 'number' ||
    !Number.isFinite(tokens) ||
    tokens < 0 ||
    typeof contextWindow !== 'number' ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0
  ) {
    return null
  }
  return {
    model: model || null,
    effort: effort || null,
    usedTokens: tokens,
    maxTokens: contextWindow,
    remainingTokens: Math.max(0, contextWindow - tokens),
    usedPercent: Math.min(100, (tokens / contextWindow) * 100),
    source: 'provider',
    observedAt: Date.now(),
    compaction: 'idle',
    compactionUpdatedAt: null
  }
}

export function ompToolMessage(frame: OmpRpcFrame): NativeChatMessage {
  const callId = typeof frame.callId === 'string' ? frame.callId : randomUUID()
  const blocks: NativeChatMessage['blocks'] = [
    {
      type: 'tool-call',
      callId,
      name: typeof frame.toolName === 'string' ? frame.toolName : 'Tool',
      input: frame.args
    }
  ]
  if (frame.type === 'tool_execution_end') {
    blocks.push({
      type: 'tool-result',
      callId,
      output: typeof frame.result === 'string' ? frame.result : JSON.stringify(frame.result),
      isError: frame.isError === true
    })
  }
  return {
    id: `omp:tool:${callId}`,
    role: 'tool',
    blocks,
    timestamp: Date.now(),
    source: 'stream'
  }
}

export function ompConfiguration(input: {
  commands: OmpCommand[]
  modelChoices: { label: string; value: string }[]
  currentModel: string
  currentEffort: string
}): StructuredProviderConfiguration {
  return {
    commands: input.commands,
    canCompact: true,
    canFork: true,
    options: [
      {
        id: 'model',
        label: 'Model',
        description: 'Active OMP model',
        category: 'model',
        kind: {
          type: 'select',
          currentValue: input.currentModel,
          choices: input.modelChoices
        },
        valueSource: 'applied',
        transport: 'agent-session',
        settable: true
      },
      {
        id: 'effort',
        label: 'Thinking',
        description: 'OMP thinking level',
        category: 'thought_level',
        kind: {
          type: 'select',
          currentValue: input.currentEffort,
          choices: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({
            label: value,
            value
          }))
        },
        valueSource: 'applied',
        transport: 'agent-session',
        settable: true
      }
    ]
  }
}
