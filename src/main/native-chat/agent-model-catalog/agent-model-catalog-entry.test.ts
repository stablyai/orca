import { expect, it } from 'vitest'
import { agentModelCatalogEntryWithSuccess } from './agent-model-catalog-entry'

const listing = (id: string, levels: string[]) => ({
  models: [
    { id, label: id, isDefault: true, efforts: levels.map((value) => ({ value, label: value })) }
  ],
  origin: 'probe' as const
})

it('keeps whole observations by provenance, including known-empty menus', () => {
  const identity = { agent: 'pi', fingerprint: 'scope' }
  const process = agentModelCatalogEntryWithSuccess(
    undefined,
    identity,
    listing('pi/model', ['high', 'xhigh']),
    'live',
    1
  )!
  const advisory = agentModelCatalogEntryWithSuccess(
    process,
    identity,
    { ...listing('other', ['high']), advisory: true },
    'discovery',
    2
  )
  expect(advisory).toBe(process)
  const next = agentModelCatalogEntryWithSuccess(
    process,
    identity,
    listing('pi/model', []),
    'live',
    3
  )!
  expect(next.models[0]?.efforts).toEqual([])
  const discovery = agentModelCatalogEntryWithSuccess(
    next,
    identity,
    listing('new', ['low']),
    'discovery',
    4
  )!
  expect(
    agentModelCatalogEntryWithSuccess(discovery, identity, listing('old', ['max']), 'live', 5)
  ).toBe(discovery)
  expect(discovery.models.map((row) => row.id)).toEqual(['new'])
})
