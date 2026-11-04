import { describe, expect, it } from 'vitest'
import type { AgentSessionModelOption } from '../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import { mergedAgentModelCatalogModels } from './agent-model-catalog-models'
import type { AgentModelCatalogListing } from './agent-model-catalog-entry'

function listing(at: number, model: AgentSessionModelOption): AgentModelCatalogListing {
  return { models: [model], origin: at === 1 ? 'probe' : 'live-session', at }
}

describe('mergedAgentModelCatalogModels', () => {
  it('preserves earlier details when a newer live answer omits or leaves fields undefined', () => {
    const earlier: AgentSessionModelOption = {
      id: 'opencode/beam',
      label: 'Beam',
      isDefault: false,
      efforts: [],
      details: { provider: 'OpenCode', inputs: ['text'], contextWindowTokens: 32_000 }
    }
    const later: AgentSessionModelOption = {
      id: 'opencode/beam',
      label: 'Beam',
      isDefault: false,
      efforts: [],
      details: { provider: undefined, reasoning: true }
    }

    const merged = mergedAgentModelCatalogModels(listing(1, earlier), listing(2, later), null)

    expect(merged[0]?.details).toEqual({
      provider: 'OpenCode',
      inputs: ['text'],
      contextWindowTokens: 32_000,
      reasoning: true
    })
  })
})
