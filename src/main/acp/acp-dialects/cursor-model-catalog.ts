import { z } from 'zod'
import type { AgentSessionModelOption } from '../../../shared/agent-session/agent-session-wire'
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

/** Lists every model with its own effort levels and Fast support, before any session exists. */
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
      ...(fast?.type === 'select' ? { defaultFastMode: fast.currentValue === 'true' } : {})
    }
  })
}
