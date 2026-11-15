import { expect, it } from 'vitest'
import {
  agentModelCatalogEntry,
  agentModelCatalogEntryWithSuccess,
  type AgentModelCatalogListing
} from './agent-model-catalog-entry'

const menu = (...levels: string[]) => levels.map((value) => ({ value, label: value }))

it('retains Antigravity discovered per-model efforts across live-session listings with unknown unselected efforts', () => {
  const discovered: AgentModelCatalogListing = {
    origin: 'probe',
    at: 1,
    models: [
      {
        id: 'gemini-4-hydrogen',
        label: 'Gemini 4 Hydrogen',
        isDefault: false,
        efforts: menu('low', 'medium', 'high', 'xhigh')
      },
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        isDefault: false,
        efforts: menu('low', 'medium', 'high')
      },
      {
        id: 'gemini-pro-orchestrator',
        label: 'Orchestrator (Carbon)',
        isDefault: false,
        efforts: []
      }
    ]
  }
  const live: AgentModelCatalogListing = {
    origin: 'live-session',
    at: 2,
    models: [
      {
        id: 'gemini-4-hydrogen',
        label: 'Gemini 4 Hydrogen',
        isDefault: false,
        efforts: [],
        effortsKnown: false
      },
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        isDefault: false,
        efforts: menu('low', 'medium', 'high')
      },
      {
        id: 'gemini-pro-orchestrator',
        label: 'Orchestrator (Carbon)',
        isDefault: false,
        efforts: [],
        effortsKnown: false
      }
    ]
  }

  const merged = agentModelCatalogEntry('antigravity', 'fp', discovered, live, null)!
  expect(merged.models.find((m) => m.id === 'gemini-4-hydrogen')).toMatchObject({
    efforts: menu('low', 'medium', 'high', 'xhigh')
  })
  expect(merged.models.find((m) => m.id === 'gemini-4-hydrogen')).not.toHaveProperty('effortsKnown')
  expect(merged.models.find((m) => m.id === 'claude-opus-5-5')?.efforts).toEqual(
    menu('low', 'medium', 'high')
  )
  expect(merged.models.find((m) => m.id === 'gemini-pro-orchestrator')?.efforts).toEqual([])

  const updated = agentModelCatalogEntryWithSuccess(
    merged,
    { agent: 'antigravity', fingerprint: 'fp' },
    { origin: 'live-session', models: live.models },
    'live',
    3
  )!
  expect(updated.models.find((m) => m.id === 'gemini-4-hydrogen')?.efforts).toEqual(
    menu('low', 'medium', 'high', 'xhigh')
  )
})
