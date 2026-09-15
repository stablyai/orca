import { describe, expect, it } from 'vitest'
import { setClaudeStructuredOption } from './claude-structured-options'
import type { ClaudeSession } from './claude-structured-session-state'
import { PROVIDER_SESSION_ID, acquired, fakeClaude } from './claude-structured-session-test-support'

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
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' }
]

function initFrame(model: string): Record<string, unknown> {
  // Keys mirror the real per-turn system/init frame: it carries `model` as the
  // resolved id, and no effort of any kind.
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
      current: { model: 'sonnet' }
    })

    // The CLI's own report of what it is running — the only channel that carries
    // it, since set_model answers success for a model it never resolves.
    claude.connections[0]!.handlers.onMessage?.(initFrame('claude-haiku-4-5-20251001'))

    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'haiku' }
    })
  })

  it('keeps a just-set model until the next turn reports one', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })

    // No turn has run, so the acquisition-time report is older than the write and
    // must not flip the pill back to the model the session started on.
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
      current: { model: 'sonnet' }
    })
  })

  it('guards an effort against the model the turn reported, not the one that was set', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })
    // set_model answered success for a model it never resolved; the turn runs sonnet.
    claude.connections[0]!.handlers.onMessage?.(initFrame('claude-sonnet-5'))

    // The picker offers sonnet's levels, so refusing one under haiku — a model the
    // pill does not show and the child is not running — is the false positive.
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    ).resolves.toMatchObject({ effort: 'high' })
  })

  it('keeps guarding against the reported model across a second effort write', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })
    claude.connections[0]!.handlers.onMessage?.(initFrame('claude-sonnet-5'))
    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })

    // The effort write bumps the option fence but does not change what the child
    // runs, so the sonnet report is still current and still governs the guard.
    // `max` skips the settings readback by contract, so only the catalog gates it:
    // sonnet advertises it, haiku advertises no effort control at all.
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'max', fence: 7 })
    ).resolves.toMatchObject({ effort: 'max' })
  })

  it('guards an effort against a just-set model no turn has reported yet', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })

    // The acquisition-time report predates the write, so haiku — which advertises
    // no effort control — is still the model the guard must answer for.
    await expect(
      adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    ).rejects.toThrow('claude model haiku does not accept effort high')
  })

  it('stops vouching for a confirmed effort once the model changes', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)

    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    await expect(adapter.readOptions({ sessionId: 'session-1', fence: 7 })).resolves.toMatchObject({
      current: { model: 'sonnet', effort: 'high', confirmed: ['model', 'effort'] }
    })

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })

    // The readback was taken under sonnet; nothing has reported haiku holding it.
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
      session: {
        options: new Map<string, string>([['model', 'sonnet']]),
        reportedOptions: {},
        optionMutationSequence: 0,
        confirmedOptions: new Set<string>(),
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
        }
      } as unknown as ClaudeSession,
      calls
    }
  }

  it('records a session-scoped effort the persisted settings never carry', async () => {
    // `max` applies for the session and is deliberately excluded from the
    // persisted effortLevel, so the readback reporting `high` is an absence of
    // evidence, not a refusal — and the CLI offers `max` in its own catalog.
    const { session, calls } = sessionWith('high')

    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'max' }, undefined)
    ).resolves.toEqual({ model: 'sonnet', effort: 'max' })
    expect(calls).toEqual(['list_models', 'apply:max'])
  })
})
