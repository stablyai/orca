import { describe, expect, it } from 'vitest'
import { readClaudeSettingsModel } from './claude-structured-session-options'
import {
  acquired,
  adapterFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'

const models = [
  { value: 'default', resolvedModel: 'recommended-model' },
  { value: 'recommended', resolvedModel: 'recommended-model', displayName: 'Recommended' },
  {
    value: 'selected[1m]',
    resolvedModel: 'selected-model[1m]',
    displayName: 'Selected',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high']
  }
]

describe('Claude model before the first turn', () => {
  it('uses the applied setting instead of the recommended catalog entry', async () => {
    const claude = fakeClaude({
      initProof: 'session-start',
      settings: {
        applied: { model: 'selected-model[1m]' },
        effective: { model: 'recommended-model', effortLevel: 'high' }
      },
      routes: { list_models: () => models }
    })
    const adapter = await acquired(claude)
    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current).toMatchObject({ model: 'selected[1m]', effort: 'high' })
    expect(options.current.confirmed).toContain('model')
    expect(adapter.readContext('session-1')?.model).toBe('selected-model[1m]')
    expect(
      claude.connections[0]!.calls.filter((call) => call.subtype === 'get_settings')
    ).toHaveLength(1)
    expect(claude.connections[0]!.calls.some((call) => call.subtype === 'set_model')).toBe(false)
  })

  it.each([null, {}, { effective: { model: 'not-applied' } }, { applied: { model: ' ' } }])(
    'does not guess a model from an unavailable applied setting: %j',
    async (settings) => {
      expect(readClaudeSettingsModel(settings)).toBeNull()
      const claude = fakeClaude({
        initProof: 'session-start',
        settings: settings ?? {},
        routes: { list_models: () => models }
      })
      const adapter = await acquired(claude)
      const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
      expect(options.current.model).toBe('')
      expect(options.models.some((model) => !model.id)).toBe(false)
      expect(options.descriptors?.find((option) => option.id === 'model')).toMatchObject({
        valueSource: 'unknown',
        kind: { type: 'select', choices: expect.any(Array) }
      })
      expect(options.descriptors?.[0].kind.currentValue).toBeUndefined()
    }
  )

  it('keeps an explicit launch model without issuing a redundant model write', async () => {
    const claude = fakeClaude({ initProof: 'session-start', settings: {} })
    const adapter = await acquired(claude, { options: { model: 'custom-launch-model' } })
    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.model).toBe('custom-launch-model')
    expect(options.current.confirmed ?? []).not.toContain('model')
    expect(claude.connections[0]!.calls.some((call) => call.subtype === 'set_model')).toBe(false)
  })

  it('restores an explicit selection over the acquisition-time settings report', async () => {
    const claude = fakeClaude({
      initProof: 'session-start',
      settings: { applied: { model: 'selected-model[1m]' } },
      routes: { list_models: () => models }
    })
    const adapter = adapterFor(claude)
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'custom-saved-model' }
    })
    expect((await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current.model).toBe(
      'custom-saved-model'
    )
  })
})
