import { describe, expect, it } from 'vitest'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../shared/structured-agent-session-options'
import { CLAUDE_SESSION_OPTION_CATALOG } from '../../shared/agent-session-option-catalog-claude-codex'
import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import type { SessionOptionDescriptor } from '../../shared/native-chat/input/native-chat-session-options'
import { setClaudeStructuredOption } from './claude-structured-options'
import type { ClaudeSession } from './claude-structured-session-state'
import { PROVIDER_SESSION_ID, acquired, fakeClaude } from './claude-structured-session-test-support'

/** Claude Code 2.1.260 list_models fixture; Haiku omits both effort keys. */
const CATALOG = [
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' }
]

function initFrame(model: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: PROVIDER_SESSION_ID,
    uuid: 'turn-init-uuid',
    model,
    apiKeySource: 'none'
  }
}

function modelPill(result: AgentSessionOptionsResult): SessionOptionDescriptor | undefined {
  const state = applyStructuredAgentSessionOptions(
    createStructuredAgentSessionOptionState('claude'),
    CLAUDE_SESSION_OPTION_CATALOG,
    result
  )
  return structuredAgentSessionOptionSnapshot(state).find((d) => d.category === 'model')
}

function modelSource(result: AgentSessionOptionsResult): string | undefined {
  return modelPill(result)?.valueSource
}

function modelValue(result: AgentSessionOptionsResult): string | undefined {
  const kind = modelPill(result)?.kind
  return kind?.type === 'select' ? kind.currentValue : undefined
}

describe('structured option confirmation reaches the pill', () => {
  it('shows a just-set model before any turn reports it', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })

    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.current.confirmed ?? []).not.toContain('model')
    expect(modelSource(result)).toBe('dispatched')
  })

  it('marks the model reported once the provider names it back', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })
    claude.connections[0]!.handlers.onMessage?.(initFrame('claude-haiku-4-5-20251001'))

    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.current.confirmed).toContain('model')
    expect(modelSource(result)).toBe('reported')
  })

  it('records an effort the readback could not take without confirming it', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      settings: { applied: {}, effective: {}, sources: {} },
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    // Max is session-only and cannot be confirmed through persisted settings.
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'max', fence: 7 })

    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.current.effort).toBe('max')
    expect(result.current.confirmed ?? []).not.toContain('effort')
  })

  it('confirms an effort the readback agreed with', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      settings: { applied: { effort: 'low' }, effective: { effortLevel: 'low' }, sources: {} },
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'low', fence: 7 })

    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(result.current.confirmed).toContain('effort')
  })

  it('treats a host that reports no confirmation as unconfirmed', () => {
    // Older hosts omit confirmed; preserve their value with unconfirmed provenance.
    const result = {
      models: [{ id: 'haiku', label: 'Haiku', isDefault: false, efforts: [] }],
      current: { model: 'haiku' }
    }
    expect(modelSource(result)).toBe('dispatched')
    expect(modelValue(result)).toBe('haiku')
  })
})

describe('the provider report corrects the pill', () => {
  it('moves the pill to the model the turn actually ran', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })
    expect(modelValue(await adapter.readOptions({ sessionId: 'session-1', fence: 7 }))).toBe(
      'haiku'
    )

    claude.connections[0]!.handlers.onMessage?.(initFrame('claude-sonnet-5'))

    const corrected = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(modelValue(corrected)).toBe('claude-sonnet-5')
    expect(corrected.current.confirmed).toContain('model')
  })

  it('lets a newer write outrank the report it precedes', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    claude.connections[0]!.handlers.onMessage?.(initFrame('claude-sonnet-5'))
    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })

    const result = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(modelValue(result)).toBe('haiku')
    expect(result.current.confirmed ?? []).not.toContain('model')
  })
})

describe('confirmation never outlives the write it belongs to', () => {
  it('drops an earlier effort confirmation when the value changes', async () => {
    const calls: string[] = []
    let reported = 'low'
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every session member the option paths under test read.
    const session = {
      options: new Map<string, string>([['model', 'sonnet']]),
      reportedOptions: {},
      optionMutationSequence: 0,
      confirmedOptions: new Set<string>(),
      appliedInputOptions: new Map(),
      connection: {
        supportedModels: async () => CATALOG,
        applyFlagSettings: async (s: { effortLevel?: string }) => {
          calls.push(`apply:${s.effortLevel}`)
        },
        getSettings: async () => ({
          applied: { effort: reported },
          effective: { effortLevel: reported },
          sources: {}
        })
      },
      startup: { state: 'proven' }
    } as unknown as ClaudeSession

    await setClaudeStructuredOption(session, { key: 'effort', value: 'low' }, undefined)
    expect(session.confirmedOptions.has('effort')).toBe(true)

    await setClaudeStructuredOption(session, { key: 'effort', value: 'max' }, undefined)
    expect(session.options.get('effort')).toBe('max')
    expect(session.confirmedOptions.has('effort')).toBe(false)
    expect(calls).toEqual(['apply:low', 'apply:max'])
  })
})
