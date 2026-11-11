import { describe, expect, it } from 'vitest'
import { parseAntigravityModelCatalogListing } from './antigravity-model-catalog-listing'

const AGY_V1_5_4_MODELS_STDOUT = [
  '\r\u001b[2K⠋ Fetching available models...\r',
  'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
  'gemini-4-carbon-high\tGemini 4 Carbon (High)',
  'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
  'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
  'gemini-4-argon-high\tGemini 4 Argon (High)',
  'gemini-4-argon-low\tGemini 4 Argon (Low)',
  'gemini-3.8-flash-high\tGemini 3.8 Flash (High)',
  'gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)',
  'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)',
  'claude-opus-5-5-low\tClaude Opus 5.5 (Low)',
  'claude-opus-5-5-medium\tClaude Opus 5.5 (Medium)',
  'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
  'claude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)',
  'claude-sonnet-5-5-medium\tClaude Sonnet 5.5 (Medium)',
  'claude-sonnet-5-5-high\tClaude Sonnet 5.5 (High)',
  'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
].join('\r\n')

const THREE_EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' }
]

describe('parseAntigravityModelCatalogListing', () => {
  it('folds multi-effort families into canonical ACP models while keeping single-variant models literal', () => {
    expect(parseAntigravityModelCatalogListing(AGY_V1_5_4_MODELS_STDOUT)).toEqual([
      {
        id: 'gemini-4-carbon',
        label: 'Gemini 4 Carbon',
        isDefault: false,
        efforts: THREE_EFFORTS
      },
      {
        id: 'gemini-4-argon',
        label: 'Gemini 4 Argon',
        isDefault: false,
        efforts: THREE_EFFORTS
      },
      {
        id: 'gemini-3.8-flash',
        label: 'Gemini 3.8 Flash',
        isDefault: false,
        efforts: THREE_EFFORTS
      },
      {
        id: 'claude-opus-5-5',
        label: 'Claude Opus 5.5',
        isDefault: false,
        efforts: THREE_EFFORTS
      },
      {
        id: 'claude-sonnet-5-5',
        label: 'Claude Sonnet 5.5',
        isDefault: false,
        efforts: THREE_EFFORTS
      },
      {
        id: 'gpt-oss-120b-medium',
        label: 'GPT-OSS 120B (Medium)',
        isDefault: false,
        efforts: []
      }
    ])
  })
})
