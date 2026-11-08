import { z } from 'zod'
import type { AgentSessionModelOption } from '../../shared/agent-session/agent-session-wire'
import { labelFromModelId } from '../../shared/model-id-label'

// Lists the account's models without opening a session; V3's `acp` rejects `--model`/`--effort`.
export const KIRO_MODEL_LISTING_ARGS = ['chat', '--list-models', '--format', 'json'] as const

const listingSchema = z.looseObject({
  models: z.array(
    z.looseObject({ model_id: z.string().min(1), description: z.string().optional() })
  ),
  default_model: z.string().optional()
})

export function parseKiroModelListing(stdout: string): AgentSessionModelOption[] {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return []
  }
  const listing = listingSchema.safeParse(json)
  if (!listing.success) {
    return []
  }
  const { models, default_model: defaultModel } = listing.data
  return models.map((model) => ({
    id: model.model_id,
    // The listing's model_name repeats the id; this matches the names Kiro's chat sessions show.
    label: labelFromModelId(model.model_id),
    ...(model.description ? { description: model.description } : {}),
    isDefault: model.model_id === defaultModel,
    // Kiro offers a model's effort levels only once a session runs that model.
    efforts: [],
    effortsKnown: false
  }))
}
