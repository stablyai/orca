import { z } from 'zod'
import type { AgentSessionModelOption } from '../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { labelFromModelId } from '../../shared/agent-session/options/model-catalog/model-id-label'

// Lists the account's models without opening a session; V3's `acp` rejects `--model`/`--effort`.
export const KIRO_MODEL_LISTING_ARGS = ['chat', '--list-models', '--format', 'json'] as const

// Auto picks the model per prompt and reports no effort.
const KIRO_AUTO_MODEL = 'auto'
const KIRO_UNCONFIRMED_EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

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
    efforts: [],
    // Kiro reports a model's efforts only once a chat runs it, so these are chat-only and checked at send.
    ...(model.model_id === KIRO_AUTO_MODEL ? {} : { chatEfforts: KIRO_UNCONFIRMED_EFFORTS }),
    effortsKnown: false
  }))
}
