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

const unknownChat = (
  at: number,
  efforts: ReturnType<typeof menu> = []
): AgentModelCatalogListing => ({
  ...listing('live-session', at, efforts),
  models: [{ id: 'openai/gpt-6', label: 'GPT-6', isDefault: false, efforts, effortsKnown: false }]
})

describe('a model whose newer chat listing does not know its efforts', () => {
  it('takes the menu the older listing supplies', () => {
    const merged = model(listing('probe', 1, menu('off', 'high')), unknownChat(2))
    expect(merged?.efforts).toEqual(menu('off', 'high'))
    expect(merged).not.toHaveProperty('effortsKnown')
  })

  it('stays unknown when no listing knows its menu', () => {
    expect(model(unknownChat(1), unknownChat(2))).toMatchObject({ effortsKnown: false })
  })

  it('prefers known probe evidence over an older unknown chat offering the configured effort', () => {
    const merged = model(
      listing('probe', 2, menu('low', 'high')),
      unknownChat(1, menu('off', 'auto', 'xhigh'))
    )
    expect(merged?.efforts).toEqual(menu('low', 'high'))
    expect(merged).not.toHaveProperty('effortsKnown')
    expect(merged).not.toHaveProperty('defaultEffort')
  })

  it('keeps native suggestions unknown without a known model menu', () => {
    const older = unknownChat(1, menu('low', 'high'))
    const newer = unknownChat(2, menu('off', 'auto'))
    for (const discovered of [null, { ...older, origin: 'probe' as const }]) {
      const merged = agentModelCatalogEntry('omp', 'fp', discovered, newer, null)?.models[0]
      expect(merged).toMatchObject({ efforts: menu('off', 'auto'), effortsKnown: false })
      expect(merged).not.toHaveProperty('defaultEffort')
    }
    expect(model({ ...older, origin: 'probe' }, unknownChat(2))).toMatchObject({
      efforts: menu('low', 'high'),
      effortsKnown: false
    })
  })
})
