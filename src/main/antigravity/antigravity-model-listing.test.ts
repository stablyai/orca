import { expect, it } from 'vitest'
import { antigravityListedFamilySelection, parseAgyModelListing } from './antigravity-model-listing'

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
