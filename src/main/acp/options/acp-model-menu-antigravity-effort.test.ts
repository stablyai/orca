import { expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from '../acp-dialects/antigravity-dialect'
import { acpModelMenuModels } from './acp-model-menu'

const effortOption = {
  id: 'effort',
  name: 'Reasoning effort',
  category: 'thought_level',
  type: 'select' as const,
  currentValue: 'high',
  options: [{ value: 'high', name: 'High' }]
}

const state = {
  currentModelId: 'gemini-pro-orchestrator',
  availableModels: [
    { modelId: 'gemini-pro-orchestrator', name: 'Orchestrator' },
    { modelId: 'gemini-pro-orchestrator-neon', name: 'Orchestrator Neon' },
    { modelId: 'gemini-pro-orchestrator-argon', name: 'Orchestrator Argon' },
    { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon High' },
    { modelId: 'other-model', name: 'Other' }
  ]
}

it('advertises selectable efforts for Antigravity Orchestrator models (#50508)', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures carry every field the menu reads; only ACP's open-ended _meta is omitted.
  const models = acpModelMenuModels({
    dialect: ANTIGRAVITY_ACP_DIALECT,
    modelOption: null,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same as above; the effort select needs only its choices and current value.
    effortOption: effortOption as never,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: same as above; ModelInfo is an open zod object.
    state: state as never,
    currentModel: 'gemini-pro-orchestrator'
  })

  const orchestrators = models.filter((model) => model.id.startsWith('gemini-pro-orchestrator'))
  expect(orchestrators).toHaveLength(3)
  for (const model of orchestrators) {
    expect(model.effortsKnown).not.toBe(false)
    expect(model.efforts.map((effort) => effort.value)).toEqual(['low', 'medium', 'high', 'xhigh'])
  }
  expect(models.find((model) => model.id === 'other-model')?.effortsKnown).toBe(false)
  expect(models.find((model) => model.id === 'gemini-4-neon-high')?.effortsKnown).toBe(false)
})
