import type {
  AgentSessionFastModeSupport,
  AgentSessionOptionsResult
} from '../../shared/agent-session-wire'
import type { ListedModel } from './claude-structured-model-catalog'

const TRANSIENT_FAST_MODE_REASONS = new Set(['network_error', 'unknown', 'pending'])
const NON_BLOCKING_FAST_MODE_REASONS = new Set(['preference', 'sdk_opt_in_required'])

export function claudeFastModeSupport(
  models: readonly ListedModel[],
  disabledReason: string | undefined
): AgentSessionFastModeSupport | undefined {
  if (disabledReason && TRANSIENT_FAST_MODE_REASONS.has(disabledReason)) {
    return undefined
  }
  if (disabledReason && !NON_BLOCKING_FAST_MODE_REASONS.has(disabledReason)) {
    return { supported: false, reason: disabledReason }
  }
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
