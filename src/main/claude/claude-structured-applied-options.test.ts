import { describe, expect, it } from 'vitest'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  acquired,
  adapterFor,
  fakeClaude,
  identityFor,
  claudeOpened
} from './claude-structured-session-test-support'

/** Claude Code 2.1.280 list_models fixture; default and opus[1m] resolve to the same model. */
const CATALOG = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5-5[1m]',
    displayName: 'Default (recommended)',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    value: 'opus[1m]',
    resolvedModel: 'claude-opus-5-5[1m]',
    displayName: 'Opus (1M context)',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' }
]

/** Claude Code 2.1.280 scratch-config responses: applied includes env resolution; effective reflects settings. */
const SETTINGS = {
  noOverride: {
    effective: {},
    sources: [],
    applied: { model: 'claude-opus-5-5[1m]', effort: 'medium', advisor: null, ultracode: false }
  },
  settingsHaiku: {
    effective: { model: 'haiku' },
    sources: [{ source: 'userSettings', settings: { model: 'haiku' } }],
    applied: { model: 'claude-haiku-4-5-20251001', effort: null, advisor: null, ultracode: false }
  },
  envSonnet: {
    effective: {},
    sources: [],
    applied: { model: 'claude-sonnet-5', effort: 'high', advisor: null, ultracode: false }
  },
  settingsHaikuEnvSonnet: {
    effective: { model: 'haiku' },
    sources: [{ source: 'userSettings', settings: { model: 'haiku' } }],
    applied: { model: 'claude-sonnet-5', effort: 'high', advisor: null, ultracode: false }
  }
}

function startedWithoutATurn(settings: unknown) {
  // The real startup proof before any turn is the SessionStart hook frame, which names no model.
  return fakeClaude({
    initProof: 'session-start',
    initModels: CATALOG,
    settings,
    routes: { list_models: () => CATALOG }
  })
}

async function readCurrent(settings: unknown) {
  const adapter = await acquired(startedWithoutATurn(settings))
  return (await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).current
}

describe('Claude model before the first turn', () => {
  it.each([
    ['nothing overrides the default', SETTINGS.noOverride, 'claude-opus-5-5[1m]', 'medium'],
    ['settings name a model', SETTINGS.settingsHaiku, 'claude-haiku-4-5-20251001', undefined],
    ['the env names a model', SETTINGS.envSonnet, 'claude-sonnet-5', 'high'],
    ['the env overrides the settings', SETTINGS.settingsHaikuEnvSonnet, 'claude-sonnet-5', 'high']
  ])(
    'names what Claude will apply when %s, unconfirmed',
    async (_case, settings, model, effort) => {
      const current = await readCurrent(settings)

      expect(current.model).toBe(model)
      expect(current.effort).toBe(effort)
      expect(current.confirmed ?? []).not.toContain('model')
      expect(current.confirmed ?? []).not.toContain('effort')
    }
  )

  it('marks an unknown applied model as defaulted for the host to resolve', async () => {
    const current = await readCurrent({ effective: {}, sources: [] })

    expect(current.defaulted).toEqual(['model'])
    expect(current.effort).toBeUndefined()
  })

  it('lets the first turn confirm or correct it', async () => {
    const claude = startedWithoutATurn(SETTINGS.settingsHaiku)
    const adapter = await acquired(claude)

    claude.connections[0]!.handlers.onMessage?.({
      type: 'system',
      subtype: 'init',
      session_id: PROVIDER_SESSION_ID,
      uuid: 'turn-init-uuid',
      model: 'claude-sonnet-5',
      apiKeySource: 'none'
    })

    const { current } = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(current.model).toBe('claude-sonnet-5')
    expect(current.confirmed).toContain('model')
  })

  it('starts a new chat on the model Claude will apply, which is what the session persists', async () => {
    const events: ClaudeStructuredSessionEvent[] = []
    await acquired(startedWithoutATurn(SETTINGS.settingsHaiku), {}, events)

    const reported = events.find((event) => event.type === 'options-reported')
    expect(reported).toMatchObject({ reportedOptions: { model: 'claude-haiku-4-5-20251001' } })
  })

  it('shows the applied effort but never persists it as the session options', async () => {
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(startedWithoutATurn(SETTINGS.noOverride), {}, events)

    const started = await claudeOpened(adapter, 'session-1')
    expect(started.reportedOptions).not.toHaveProperty('model')
    // Saved, it would be restored on every reopen past a later settings.json change.
    expect(started.reportedOptions).not.toHaveProperty('effort')
    const reported = events.find((event) => event.type === 'options-reported')
    expect(
      reported?.type === 'options-reported' ? reported.reportedOptions : null
    ).not.toHaveProperty('effort')
    const { current } = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(current.effort).toBe('medium')
  })

  it('re-reads what Claude will apply after a model write', async () => {
    const settings = structuredClone(SETTINGS.settingsHaiku)
    const claude = startedWithoutATurn(settings)
    const adapter = await acquired(claude)

    await adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'model', value: 'sonnet' })
    Object.assign(settings.applied, { model: 'claude-sonnet-5', effort: 'high' })

    const { current } = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(current).toMatchObject({ model: 'sonnet', effort: 'high' })
  })

  it('drops the applied effort once a restored model replaces the model it described', async () => {
    const claude = startedWithoutATurn(SETTINGS.noOverride)
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = adapterFor(claude, { resumesTranscript: true, continuesChain: true }, events)

    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'spawn-9',
      options: { model: 'haiku' }
    })

    const started = await claudeOpened(adapter, 'session-1')
    expect(started.reportedOptions).not.toHaveProperty('model')
    expect(started.reportedOptions.effort).toBeUndefined()
  })
})
