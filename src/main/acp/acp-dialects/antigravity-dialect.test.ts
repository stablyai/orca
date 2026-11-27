import { expect, it } from 'vitest'
import {
  ANTIGRAVITY_ACP_DIALECT,
  antigravityListedFamilySelection,
  antigravityModelChoices
} from './antigravity-dialect'
import { parseAgyModelListing } from '../../antigravity/antigravity-model-listing'
import { acpModelMenuModels } from '../options/acp-model-menu'

// `agy models` 1.5.14: gemini-3.5-flash is a model itself, so its levels stay their own rows.
const LISTED = parseAgyModelListing(
  [
    'gemini-4-argon-high\tGemini 4 Argon (High)',
    'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
    'gemini-4-argon-low\tGemini 4 Argon (Low)',
    'gemini-3.5-flash-medium\tGemini 3.5 Flash (Medium)',
    'gemini-3.5-flash\tGemini 3.5 Flash (High)',
    'gemini-3.5-flash-low\tGemini 3.5 Flash (Low)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
  ].join('\n')
)

it('folds only a level id the listing groups into its family', () => {
  const pick = (model: string, effort?: string) =>
    antigravityListedFamilySelection({ model, ...(effort ? { effort } : {}) }, LISTED)
  expect(pick('gemini-4-argon-medium', 'medium')).toEqual({
    model: 'gemini-4-argon',
    effort: 'medium'
  })
  expect(pick('gemini-4-argon-medium')).toEqual({ model: 'gemini-4-argon', effort: 'medium' })
  expect(pick('gemini-4-argon-medium', 'high')).toEqual({ model: 'gemini-4-argon', effort: 'high' })
  expect(pick('gemini-4-argon-medium', 'xhigh')).toBeNull()
  expect(pick('gemini-3.5-flash-medium', 'medium')).toBeNull()
  expect(pick('gpt-oss-120b-medium', 'medium')).toBeNull()
})

it('keeps a listed level id even when its family row offers that level', () => {
  // A live ACP menu with gemini-3.5-flash current gives that row the session's level picker.
  const argon = LISTED.find((model) => model.id === 'gemini-4-argon')
  const live = LISTED.map((model) =>
    model.id === 'gemini-3.5-flash' ? { ...model, efforts: argon?.efforts ?? [] } : model
  )
  expect(
    antigravityListedFamilySelection({ model: 'gemini-3.5-flash-medium', effort: 'medium' }, live)
  ).toBeNull()
})

// `agy models` 1.5.18 lists the Orchestrator models unsuffixed (#50508). The realtime ACP menu
// carries each model itself, so the listing is read through options the way the chat reads it.
const ORCHESTRATOR_LISTING = [
  'gemini-4-neon-high\tGemini 4 Neon (High)',
  'gemini-4-neon-xhigh\tGemini 4 Neon (XHigh)',
  'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
  'gemini-4-neon-low\tGemini 4 Neon (Low)',
  'gemini-pro-orchestrator-neon\tOrchestrator (Neon)',
  'gemini-pro-orchestrator\tOrchestrator (Carbon)',
  'gemini-pro-orchestrator-argon\tOrchestrator (Argon)'
].join('\n')

function orchestratorOptions() {
  const availableModels = ORCHESTRATOR_LISTING.split('\n').map((line) => {
    const [modelId, name] = line.split('\t')
    return { modelId, name }
  })
  const options = antigravityModelChoices(availableModels)
  const modelOption = {
    type: 'select' as const,
    id: 'model',
    name: 'Model',
    currentValue: '',
    options: options.map(({ id, label }) => ({ value: id, name: label }))
  }
  return acpModelMenuModels({
    dialect: ANTIGRAVITY_ACP_DIALECT,
    modelOption,
    effortOption: null,
    state: { availableModels, currentModelId: '' },
    currentModel: undefined
  })
}

it('offers a thinking level on the unsuffixed Orchestrator models', () => {
  const listed = orchestratorOptions()
  const efforts = (id: string) =>
    listed.find((model) => model.id === id)?.efforts.map(({ value }) => value)
  expect(efforts('gemini-pro-orchestrator-neon')).toEqual(['low', 'medium', 'high'])
  expect(efforts('gemini-pro-orchestrator')).toEqual(['low', 'medium', 'high'])
  expect(efforts('gemini-pro-orchestrator-argon')).toEqual(['low', 'medium', 'high'])
  // The level remains a launch argument, not part of the id the chat runs.
  expect(listed.find((model) => model.id === 'gemini-pro-orchestrator-neon')?.effortsKnown).toBe(
    undefined
  )
})
