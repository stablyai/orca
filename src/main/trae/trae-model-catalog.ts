import { z } from 'zod'
import type { AgentSessionModelOption } from '../../shared/agent-session/options/model-catalog/agent-session-model-option'

const modelListing = z.array(
  z.object({
    config_name: z.string().min(1),
    name: z.string().min(1),
    description: z.string().optional()
  })
)

export function parseTraeModelListing(stdout: string): AgentSessionModelOption[] {
  return modelListing.parse(JSON.parse(stdout)).map((model) => ({
    id: model.config_name,
    label: model.name,
    ...(model.description ? { description: model.description } : {}),
    isDefault: false,
    efforts: [],
    effortsKnown: false as const
  }))
}
