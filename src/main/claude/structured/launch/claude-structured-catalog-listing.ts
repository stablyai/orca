import type { AgentSessionFastModeSupport } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/agent-session-options-result'
import type { ListedModel } from './claude-structured-model-catalog'

export function claudeFastModeSupport(
  models: readonly ListedModel[]
): AgentSessionFastModeSupport | undefined {
  if (!models.some((model) => model.supportsFastMode === true)) {
    return models.length > 0 && models.every((model) => model.supportsFastMode === false)
      ? { supported: false, reason: 'model-not-supported' }
      : undefined
  }
  return { supported: true }
}

export type WireClaudeModel = AgentSessionOptionsResult['models'][number]

function wireClaudeModel(entry: ListedModel): WireClaudeModel {
  return {
    id: entry.id,
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    ...(entry.effortsKnown === false ? { effortsKnown: false as const } : {}),
    label: entry.label,
    ...(entry.description ? { description: entry.description } : {}),
    isDefault: entry.isDefault,
    efforts: entry.efforts,
    ...(entry.declaredDefaultEffort !== undefined
      ? { declaredDefaultEffort: entry.declaredDefaultEffort }
      : {}),
    ...(entry.supportsFastMode !== undefined ? { supportsFastMode: entry.supportsFastMode } : {}),
    ...(entry.supportsAutoMode !== undefined ? { supportsAutoMode: entry.supportsAutoMode } : {})
  }
}

export function wireClaudeModels(models: readonly ListedModel[]): WireClaudeModel[] {
  return models.map(wireClaudeModel)
}
