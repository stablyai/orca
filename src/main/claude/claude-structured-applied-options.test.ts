import { describe, expect, it } from 'vitest'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-adapter'
import {
  PROVIDER_SESSION_ID,
  acquired,
  adapterFor,
  fakeClaude,
  identityFor
} from './claude-structured-session-test-support'

/** Verbatim rows from Claude Code 2.1.280's list_models: `default` is the CLI's own
 *  default, and it resolves to the same model as the `opus[1m]` row. */
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

/** Verbatim get_settings answers from Claude Code 2.1.280 under a scratch config dir.
 *  `applied` is the CLI's own resolution; `effective` only ever sees settings files. */
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
  // ANTHROPIC_MODEL=sonnet with no settings model.
  envSonnet: {
    effective: {},
    sources: [],
    applied: { model: 'claude-sonnet-5', effort: 'high', advisor: null, ultracode: false }
  },
  // settings.json says haiku, ANTHROPIC_MODEL=sonnet.
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
    ['nothing overrides the default', SETTINGS.noOverride, 'opus[1m]', 'medium'],
    ['settings name a model', SETTINGS.settingsHaiku, 'haiku', undefined],
    ['the env names a model', SETTINGS.envSonnet, 'sonnet', 'high'],
    ['the env overrides the settings', SETTINGS.settingsHaikuEnvSonnet, 'sonnet', 'high']
  ])(
    'names what Claude will apply when %s, unconfirmed',
    async (_case, settings, model, effort) => {
      const current = await readCurrent(settings)

      expect(current.model).toBe(model)
      // A null applied effort means none is sent, so none is shown.
      expect(current.effort).toBe(effort)
      expect(current.confirmed ?? []).not.toContain('model')
      expect(current.confirmed ?? []).not.toContain('effort')
    }
  )

  it('falls back to the listing default only when the CLI reports no applied model', async () => {
    const current = await readCurrent({ effective: {}, sources: [] })

    expect(current.model).toBe('opus[1m]')
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
    expect(current.model).toBe('sonnet')
    expect(current.confirmed).toContain('model')
  })

  it('starts a new chat on the model Claude will apply, which is what the session persists', async () => {
    const events: ClaudeStructuredSessionEvent[] = []
    await acquired(startedWithoutATurn(SETTINGS.settingsHaiku), {}, events)

    const started = events.find((event) => event.type === 'started')
    expect(started).toMatchObject({ reportedOptions: { model: 'haiku' } })
  })

  it('shows the applied effort but never persists it as the session options', async () => {
    const events: ClaudeStructuredSessionEvent[] = []
    const adapter = await acquired(startedWithoutATurn(SETTINGS.noOverride), {}, events)

    const started = events.find((event) => event.type === 'started')
    expect(started).toMatchObject({ reportedOptions: { model: 'opus[1m]' } })
    // Saved, it would be restored on every reopen past a later settings.json change.
    expect(started?.type === 'started' ? started.reportedOptions : null).not.toHaveProperty(
      'effort'
    )
    const { current } = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(current.effort).toBe('medium')
  })

  it('re-reads what Claude will apply after a model write', async () => {
    const settings = structuredClone(SETTINGS.settingsHaiku)
    const claude = startedWithoutATurn(settings)
    const adapter = await acquired(claude)

    await adapter.setOption({ sessionId: 'session-1', fence: 7, key: 'model', value: 'sonnet' })
    // What the real CLI answers once the write has landed.
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

    // `started` is persisted as the session's options; opus's effort must not ride along onto haiku.
    const started = events.find((event) => event.type === 'started')
    expect(started).toMatchObject({ reportedOptions: { model: 'haiku' } })
    expect(started?.type === 'started' ? started.reportedOptions.effort : null).toBeUndefined()
  })
})
