import { z } from 'zod'
import { PI_THINKING_LEVELS } from '../../../../shared/agent-session/options/reconciliation/structured-agent-session-effective-effort'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/protocol/agent-session-options-result'
import { isPiModelOptionId } from '../../../../shared/agent-session/options/catalog-providers/agent-session-option-catalog-pi'
import { piRpcModelSchema } from './rpc-model-schema'

export type PiRpcRequester = {
  request(
    command: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number | null }
  ): Promise<unknown>
}

export const modelSchema = piRpcModelSchema.safeExtend({
  provider: z.string().min(1),
  id: z.string().min(1),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).optional()
})
const modelsSchema = z.object({ models: z.array(modelSchema) })

export function piModelOptionId(provider: string, modelId: string): string {
  if (!provider || !modelId || provider.includes('/')) {
    throw new Error('Pi model requires an explicit provider and model ID')
  }
  return `${provider}/${modelId}`
}

export function parsePiModelOptionId(value: string): { provider: string; modelId: string } {
  if (!isPiModelOptionId(value)) {
    throw new Error('Pi model requires an explicit provider and model ID')
  }
  const slash = value.indexOf('/')
  return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

/** Native inventory projection shared by running chats and the pre-session catalog. */
export async function readPiRpcModelOptions(
  rpc: PiRpcRequester,
  options?: { timeoutMs?: number | null }
): Promise<AgentSessionOptionsResult['models']> {
  const models = modelsSchema.parse(
    await rpc.request('get_available_models', undefined, options)
  ).models
  return models.map((model) => {
    const id = piModelOptionId(model.provider, model.id)
    const efforts =
      model.reasoning !== true
        ? []
        : PI_THINKING_LEVELS.filter((level) => {
            const mapped = model.thinkingLevelMap?.[level]
            return (
              mapped !== null && ((level !== 'xhigh' && level !== 'max') || mapped !== undefined)
            )
          }).map((level) => ({ value: level, label: level }))
    return {
      id,
      label: model.name || id,
      isDefault: false,
      efforts
    }
  })
}
