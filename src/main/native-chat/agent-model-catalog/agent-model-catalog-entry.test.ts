import { describe, expect, it } from 'vitest'
import {
  agentModelCatalogEntry,
  agentModelCatalogEntryWithSuccess,
  entryWithConfiguredDefault,
  type AgentModelCatalogListing
} from './agent-model-catalog-entry'

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

  it('drops an OMP menu an older build borrowed from the running model', () => {
    const saved = unknownChat(1, menu('low', 'medium', 'max'))
    expect(agentModelCatalogEntry('omp', 'fp', saved, null, null)?.models[0]).toMatchObject({
      efforts: [],
      effortsKnown: false
    })
  })

  it('keeps an older unknown menu when the newer listing has none', () => {
    const older = unknownChat(1, menu('low', 'high'))
    expect(model({ ...older, origin: 'probe' }, unknownChat(2))).toMatchObject({
      efforts: menu('low', 'high'),
      effortsKnown: false
    })
  })
})

it('selects the newest declaration observation before resolving its value, including unknown', () => {
  const source = (
    origin: AgentModelCatalogListing['origin'],
    at: number,
    declaredDefaultEffort?: string | null
  ) => ({
    ...listing(origin, at, menu('low', 'high')),
    models: [
      {
        ...listing(origin, at, menu('low', 'high')).models[0]!,
        defaultEffort: 'high',
        ...(declaredDefaultEffort !== undefined ? { declaredDefaultEffort } : {})
      }
    ]
  })
  for (const newerSource of ['discovery', 'live']) {
    const merged = (newer?: string | null) =>
      agentModelCatalogEntry(
        'grok',
        'fp',
        source(
          'probe',
          newerSource === 'discovery' ? 3 : 1,
          newerSource === 'discovery' ? newer : 'high'
        ),
        source(
          'live-session',
          newerSource === 'live' ? 3 : 1,
          newerSource === 'live' ? newer : 'high'
        ),
        { modelId: 'openai/gpt-6', effort: 'high', at: 0 }
      )!.models[0]
    expect(merged('low')?.declaredDefaultEffort).toBe('low')
    expect(merged(null)).toMatchObject({ declaredDefaultEffort: null, defaultEffort: 'high' })
    expect(merged()?.declaredDefaultEffort).toBe('high')
    expect(merged('low')?.declaredDefaultEffort).toBe('low')
  }
})

it('keeps late configured validation from reattaching old declaration proof to a newer listing', () => {
  const old = listing('live-session', 1, menu('low', 'high'))
  const current = {
    ...listing('live-session', 2, menu('low', 'high')),
    models: [{ ...old.models[0]!, declaredDefaultEffort: null }]
  }
  const entry = agentModelCatalogEntry('grok', 'fp', null, current, null)!
  const late = entryWithConfiguredDefault(
    entry,
    { modelId: 'openai/gpt-6', effort: 'low' },
    3,
    old
  )!
  expect(late.models[0]).toMatchObject({ defaultEffort: 'low', declaredDefaultEffort: null })
  expect(
    entryWithConfiguredDefault(late, { modelId: 'openai/gpt-6', effort: 'high' }, 4, current)
      ?.models[0]?.declaredDefaultEffort
  ).toBe('high')
})

it('marks the versioned row a configured Claude alias runs, and gives its alias the configured effort', () => {
  const efforts = menu('low', 'medium', 'high')
  const row = (id: string) => ({
    id,
    label: id,
    resolvedModel: 'claude-opus-5-5',
    isDefault: false,
    efforts
  })
  const entry = agentModelCatalogEntryWithSuccess(
    undefined,
    { agent: 'claude', fingerprint: 'fp' },
    {
      models: [row('claude-opus-5-5'), row('opus')],
      origin: 'probe',
      complete: true,
      configured: { model: 'opus', effort: 'high' }
    },
    'discovery',
    1
  )
  expect(
    entry?.models.map(({ id, isDefault, defaultEffort }) => ({ id, isDefault, defaultEffort }))
  ).toEqual([
    { id: 'claude-opus-5-5', isDefault: true, defaultEffort: 'high' },
    { id: 'opus', isDefault: false, defaultEffort: 'high' }
  ])
})
