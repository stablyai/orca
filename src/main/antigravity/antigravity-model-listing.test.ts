import { expect, it } from 'vitest'
import { parseAgyModelListing } from './antigravity-model-listing'

// agy 1.5.9 `agy models`; a chat's model select offers exactly these ids.
const LISTING = [
  'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
  'gemini-4-carbon-high\tGemini 4 Carbon (High)',
  'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
  'gemini-3.5-flash-medium\tGemini 3.5 Flash (Medium)',
  'gemini-3.5-flash\tGemini 3.5 Flash (High)',
  'gemini-3.5-flash-low\tGemini 3.5 Flash (Low)',
  'gemini-3.1-pro-low-thinking\tGemini 3.1 Pro (Low)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)',
  ''
].join('\n')

it('offers the model families and standalone models a chat offers', () => {
  const models = parseAgyModelListing(LISTING)
  expect(models.map((model) => [model.id, model.label])).toEqual([
    ['gemini-4-carbon', 'Gemini 4 Carbon'],
    ['gemini-3.5-flash-medium', 'Gemini 3.5 Flash (Medium)'],
    ['gemini-3.5-flash', 'Gemini 3.5 Flash (High)'],
    ['gemini-3.5-flash-low', 'Gemini 3.5 Flash (Low)'],
    ['gemini-3.1-pro-low-thinking', 'Gemini 3.1 Pro (Low)'],
    ['gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)']
  ])
  expect(models[0].efforts.map((effort) => effort.value)).toEqual(['low', 'medium', 'high'])
})
