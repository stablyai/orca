import { z } from 'zod'
import type { AgentSessionOptionChoice } from '../../../shared/agent-session/agent-session-wire'
import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { ModelInfo } from '../generated/acp-protocol.generated'

// Droid's own names for its reasoning_effort choices.
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: 'None',
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Maximum'
}

const effortsSchema = z.object({
  supportedReasoningEfforts: z.array(z.string().min(1)).optional(),
  defaultReasoningEffort: z.string().min(1).optional()
})

const listReplySchema = z.object({
  models: z
    .array(
      effortsSchema.extend({
        id: z.string().min(1),
        displayName: z.string().min(1),
        disabled: z.boolean().optional()
      })
    )
    .min(1)
})

function droidEfforts(input: z.infer<typeof effortsSchema>): {
  efforts: AgentSessionOptionChoice[]
  defaultEffort?: string
} {
  const values = input.supportedReasoningEfforts ?? []
  // A model whose only level is `none` cannot reason, so it gets no effort menu.
  if (values.length === 0 || (values.length === 1 && values[0] === 'none')) {
    return { efforts: [] }
  }
  const fallback = input.defaultReasoningEffort
  return {
    efforts: values.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value })),
    ...(fallback && values.includes(fallback) ? { defaultEffort: fallback } : {})
  }
}

/** Each session model carries its own efforts under `_meta.factory`. */
export function droidModelEfforts(model: Pick<ModelInfo, '_meta'>): {
  efforts: AgentSessionOptionChoice[]
  defaultEffort?: string
} {
  const parsed = effortsSchema.safeParse(model._meta?.factory ?? {})
  return parsed.success ? droidEfforts(parsed.data) : { efforts: [] }
}

/** Lists the account's models without a session, so the list leaves nothing in Droid's history. */
export async function readDroidModelCatalog(connection: {
  requestSessionFreeExtension(method: string, params: unknown): Promise<unknown>
}): Promise<AgentSessionModelOption[]> {
  const reply = listReplySchema.safeParse(
    await connection.requestSessionFreeExtension('_factory/models/list', {})
  )
  if (!reply.success) {
    throw new Error('droid did not list its models')
  }
  return reply.data.models
    .filter((model) => model.disabled !== true)
    .map((model) => ({
      id: model.id,
      label: model.displayName,
      // Each model's default effort is its own, never the account's saved choice.
      isDefault: false,
      ...droidEfforts(model)
    }))
}
