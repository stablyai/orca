import { z } from 'zod'
import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { SessionConfigOptionSchema } from '../generated/acp-protocol.generated'
import { acpEffortOption, acpSelectChoices } from '../options/acp-select-choices'

const listReplySchema = z.object({
  models: z
    .array(
      z.object({
        value: z.string(),
        name: z.string(),
        configOptions: z.array(z.unknown()).nullish()
      })
    )
    .min(1)
})

/** Lists every model with its own effort levels, Fast support and context sizes, before any session exists. */
export async function readCursorModelCatalog(connection: {
  requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
}): Promise<AgentSessionModelOption[]> {
  const reply = listReplySchema.safeParse(
    await connection.requestSessionFreeExtension('cursor/list_available_models', {})
  )
  if (!reply.success) {
    throw new Error('cursor did not list its models')
  }
  return reply.data.models.map((model) => {
    const options = (model.configOptions ?? []).flatMap(
      (raw) => SessionConfigOptionSchema.safeParse(raw).data ?? []
    )
    const effort = acpEffortOption(options)
    const fast = options.find((option) => option.id === 'fast')
    const context = options.find((option) => option.id === 'context')
    return {
      id: model.value,
      label: model.name,
      // currentValue is each model's own default, never the account's saved choice.
      isDefault: false,
      efforts: effort
        ? acpSelectChoices(effort).map((choice) => ({ value: choice.value, label: choice.name }))
        : [],
      ...(effort ? { defaultEffort: effort.currentValue } : {}),
      supportsFastMode: fast !== undefined,
      ...(fast?.type === 'select' ? { defaultFastMode: fast.currentValue === 'true' } : {}),
      // Empty, not absent: the listing saw every model, so a stale size never outlives it.
      contextWindows:
        context?.type === 'select'
          ? acpSelectChoices(context).map((choice) => ({ value: choice.value, label: choice.name }))
          : [],
      ...(context?.type === 'select' ? { defaultContextWindow: context.currentValue } : {})
    }
  })
}
