import { describe, expect, it } from 'vitest'
import { agentModelCatalogEntry, type AgentModelCatalogListing } from './agent-model-catalog-entry'

const menu = (...levels: string[]) => levels.map((value) => ({ value, label: value }))

function listing(
  origin: AgentModelCatalogListing['origin'],
  at: number,
  efforts: ReturnType<typeof menu>
): AgentModelCatalogListing {
  return {
    models: [{ id: 'openai/gpt-6', label: 'GPT-6', isDefault: false, efforts }],
    origin,
    at
  }
}

const CONFIGURED = { modelId: 'openai/gpt-6', effort: 'xhigh', at: 1 }

function model(discovered: AgentModelCatalogListing, live: AgentModelCatalogListing) {
  return agentModelCatalogEntry('pi', 'fp', discovered, live, CONFIGURED)?.models[0]
}

describe('the effort menu of a model whose configured effort one listing lacks', () => {
  it('keeps the chat’s own menu when a newer probe’s coarser menu lacks the effort it ran', () => {
    const chat = listing('live-session', 1, menu('off', 'high', 'xhigh'))
    const probe = listing('probe', 2, menu('off', 'high'))
    expect(model(probe, chat)).toMatchObject({
      efforts: menu('off', 'high', 'xhigh'),
      defaultEffort: 'xhigh'
    })
  })

  it('never brings back an older probe’s menu over the chat’s own newer one', () => {
    const probe = listing('probe', 1, menu('off', 'high', 'xhigh'))
    const chat = listing('live-session', 2, menu('off', 'high'))
    const merged = model(probe, chat)
    expect(merged?.efforts).toEqual(menu('off', 'high'))
    expect(merged).not.toHaveProperty('defaultEffort')
  })
})
