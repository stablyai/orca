import { expect, it } from 'vitest'
import { ANTIGRAVITY_LAUNCH_SPEC } from '../../../antigravity/antigravity-acp-launch-spec'
import { acpStructuredAgentDefinition } from '../../../acp/session/acp-structured-agent-definitions'
import { parseAgyModelListing } from '../../../antigravity/antigravity-model-listing'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState
} from '../../../../shared/agent-session/options/structured-agent-session-options'
import { structuredAgentSessionOptionSnapshot } from '../../../../shared/agent-session/options/view/structured-agent-session-option-snapshot'
import { structuredAgentSessionMessageSelection } from '../../../../shared/agent-session/options/view/structured-agent-session-option-view'
import { optionRefreshHost } from '../host/testing/structured-agent-session-option-refresh.test-fixture'

// `agy models` 1.5.15 lists each level as its own id.
const LISTED = parseAgyModelListing(
  [
    'gemini-4-neon-high\tGemini 4 Neon (High)',
    'gemini-4-neon-medium\tGemini 4 Neon (Medium)',
    'gemini-4-neon-low\tGemini 4 Neon (Low)',
    'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
  ].join('\n')
)

function antigravityHost(options: Record<string, string>) {
  const host = optionRefreshHost({
    provider: 'antigravity',
    options,
    definition: acpStructuredAgentDefinition(ANTIGRAVITY_LAUNCH_SPEC)
  })
  host.models = LISTED
  return host
}

async function composer(options: Record<string, string>) {
  const seed = getAgentSessionOptionCatalog('antigravity')!
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('antigravity', seed),
    seed,
    await antigravityHost(options).read()
  )
  const shown = Object.fromEntries(
    structuredAgentSessionOptionSnapshot(state).map((descriptor) => [
      descriptor.id,
      descriptor.kind.type === 'select'
        ? {
            current: descriptor.kind.currentValue,
            choices: descriptor.kind.choices.map((choice) => choice.value),
            settable: descriptor.settable
          }
        : null
    ])
  )
  return { shown, sent: structuredAgentSessionMessageSelection(state) }
}

it('shows a saved level id as its listed family and level, and sends both', async () => {
  const { shown, sent } = await composer({ model: 'gemini-4-neon-high' })
  expect(shown.model).toEqual({
    current: 'gemini-4-neon',
    choices: ['gemini-4-neon', 'gpt-oss-120b-medium'],
    settable: true
  })
  expect(shown.effort).toEqual({
    current: 'high',
    choices: ['low', 'medium', 'high'],
    settable: true
  })
  expect(sent).toEqual({ model: 'gemini-4-neon', effort: 'high' })
  expect((await composer({ model: 'gemini-4-neon-high', effort: 'low' })).sent).toEqual({
    model: 'gemini-4-neon',
    effort: 'low'
  })
})

it('keeps a model the listing does not group as its own row', async () => {
  for (const model of ['gemini-9-ultra-high', 'gpt-oss-120b-medium']) {
    const { shown, sent } = await composer({ model })
    expect(shown.model?.current).toBe(model)
    expect(shown.model?.choices).toContain(model)
    expect(sent.model).toBe(model)
  }
})

it("answers a live Antigravity chat's saved level id as the family row and level", async () => {
  const host = antigravityHost({ model: 'gemini-4-neon-high' })
  const family = host.models.find((row) => row.id === 'gemini-4-neon')!
  host.models = [family]
  host.live = { models: [family], current: { model: 'gemini-4-neon', effort: 'high' } }

  const { current, models } = await host.read()

  expect(models.map((row) => row.id)).toEqual(['gemini-4-neon'])
  expect(current).toMatchObject({
    model: 'gemini-4-neon',
    effort: 'high',
    acceptedInputSources: { model: 'saved', effort: 'saved' }
  })
  expect(host.record.options).toEqual({ model: 'gemini-4-neon-high' })
})
