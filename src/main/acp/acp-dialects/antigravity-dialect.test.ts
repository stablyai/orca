import { expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT, antigravityListedFamilySelection } from './antigravity-dialect'
import { parseAgyModelListing } from '../../antigravity/antigravity-model-listing'
import { AcpStructuredOptions } from '../options/acp-structured-options'
import { setupAcpSession } from '../protocol/acp-session-setup'

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

it('keeps models advertised by session/new when the config selector lists only Gemini', async () => {
  const started = await setupAcpSession(
    { protocolVersion: 1 },
    { cwd: '/workspace', mcpServers: [] },
    async (_method, _params, schema) =>
      schema.parse({
        sessionId: 'session',
        _meta: { antigravity: {} },
        models: {
          currentModelId: 'gemini-4-neon-high',
          availableModels: [
            { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
            { modelId: 'gemini-4-neon-xhigh', name: 'Gemini 4 Neon (XHigh)' },
            { modelId: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 (Low)' },
            { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }
          ]
        },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            type: 'select',
            category: 'model',
            currentValue: 'gemini-4-neon',
            options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }]
          },
          {
            id: 'thought_level',
            name: 'Reasoning Effort',
            type: 'select',
            category: 'thought_level',
            currentValue: 'high',
            options: [
              { value: 'high', name: 'High' },
              { value: 'xhigh', name: 'XHigh' }
            ]
          }
        ]
      })
  )
  const options = new AcpStructuredOptions(ANTIGRAVITY_ACP_DIALECT)
  options.adoptSession(started.response, 'new')
  expect(
    options.read().models.map(({ id, efforts }) => [id, efforts.map(({ value }) => value)])
  ).toEqual([
    ['gemini-4-neon', ['high', 'xhigh']],
    ['claude-opus-5-5-low', []],
    ['gpt-oss-120b-medium', []]
  ])
})
