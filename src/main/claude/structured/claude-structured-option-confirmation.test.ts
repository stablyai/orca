import { describe, expect, it, vi } from 'vitest'
import { setClaudeStructuredOption } from './launch/claude-structured-options'
import type { ClaudeSession } from './claude-structured-session-state'

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
    await vi.waitFor(() => expect(session.confirmedOptions.has('effort')).toBe(true))

    await setClaudeStructuredOption(session, { key: 'effort', value: 'max' }, undefined)
    expect(session.options.get('effort')).toBe('max')
    expect(session.confirmedOptions.has('effort')).toBe(false)
    expect(calls).toEqual(['apply:low', 'apply:max'])
  })
})
