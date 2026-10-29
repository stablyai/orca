import { describe, expect, it, vi } from 'vitest'
import { setClaudeStructuredOption } from './claude-structured-options'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import {
  PROVIDER_SESSION_ID,
  USER_MESSAGE,
  acquired,
  fakeClaude
} from './claude-structured-session-test-support'

/** Verbatim rows from Claude Code 2.1.258's list_models response. */
const CATALOG = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
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
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    supportsEffort: false
  }
]

function initFrame(model: string): Record<string, unknown> {
  // Real system/init reports a resolved model ID and omits effort.
  return {
    type: 'system',
    subtype: 'init',
    session_id: PROVIDER_SESSION_ID,
    uuid: 'turn-init-uuid',
    model,
    apiKeySource: 'none'
  }
}

describe('Claude model confirmation', () => {
  it('adopts the model a later turn reports when nothing was set since', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'claude-sonnet-5' }
    })

    claude.connections[0]!.handlers.onMessage?.(initFrame('claude-haiku-4-5-20251001'))

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'claude-haiku-4-5-20251001' }
    })
  })

  it('keeps a just-set model until the next turn reports one', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'haiku' }
    })
  })

  it('corrects the record when the turn runs a different model than was set', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })
    claude.connections[0]!.handlers.onMessage?.(initFrame('claude-sonnet-5'))

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'claude-sonnet-5' }
    })
  })

  it('stops vouching for a confirmed effort once the model changes', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    // Start a cycle to obtain the model-confirming init frame.
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'seed-cycle',
      body: USER_MESSAGE,
      fence: 7
    })

    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    await vi.waitFor(async () => {
      expect(await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).toMatchObject({
        current: { model: 'claude-sonnet-5', effort: 'high', confirmed: ['model', 'effort'] }
      })
    })

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })

    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.effort).toBe('high')
    expect(options.current.confirmed).toBeUndefined()
  })
})

describe('Claude effort the settings readback cannot report', () => {
  function sessionWith(
    reported: string,
    calls: string[] = []
  ): { session: ClaudeSession; calls: string[] } {
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every session member the option paths under test read.
      session: {
        options: new Map<string, string>([['model', 'sonnet']]),
        reportedOptions: {},
        optionMutationSequence: 0,
        confirmedOptions: new Set<string>(),
        appliedInputOptions: new Map(),
        connection: {
          supportedModels: async () => {
            calls.push('list_models')
            return CATALOG
          },
          applyFlagSettings: async (settings: { effortLevel?: string }) => {
            calls.push(`apply:${settings.effortLevel}`)
          },
          getSettings: async () => {
            calls.push('get_settings')
            return {
              applied: { effort: reported },
              effective: { effortLevel: reported },
              sources: {}
            }
          }
        },
        startup: { state: 'proven' }
      } as unknown as ClaudeSession,
      calls
    }
  }

  it('records a session-scoped effort the persisted settings never carry', async () => {
    // Max is session-only, so persisted settings cannot confirm it.
    const { session, calls } = sessionWith('high')

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'max' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'max' })
    expect(calls).toEqual(['apply:max'])
  })
})
