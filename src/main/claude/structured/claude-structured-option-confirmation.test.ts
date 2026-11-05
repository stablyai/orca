import { describe, expect, it, vi } from 'vitest'
import { setClaudeStructuredOption } from './launch/claude-structured-options'
import {
  readClaudeStructuredSessionOptions,
  refreshClaudeStructuredSessionOptions
} from './launch/claude-structured-session-options'
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
  it('corroborates only the current held effort across fresh native observations', async () => {
    const calls: string[] = []
    let settings: unknown = { applied: { effort: 'high' } }
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
        getSettings: async () => settings
      },
      startup: { state: 'proven' }
    } as unknown as ClaudeSession

    const current = async () => (await readClaudeStructuredSessionOptions(session)).current
    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'high' }, undefined)
    ).resolves.toMatchObject({ effort: 'high' })
    await vi.waitFor(async () => expect((await current()).confirmed).toContain('effort'))
    const refresh = async (next: unknown) => {
      settings = next
      await refreshClaudeStructuredSessionOptions(
        session,
        undefined,
        () => true,
        () => {}
      )
      expect((await current()).effort).toBe('high')
      expect(session.appliedInputOptions.get('effort')).toBe('high')
    }
    await refresh({})
    expect((await current()).confirmed).toContain('effort')
    await refresh({ applied: { effort: 'low' } })
    expect((await current()).confirmed ?? []).not.toContain('effort')
    await refresh({ applied: { effort: 'high' } })
    expect((await current()).confirmed).toContain('effort')
    await refresh({ applied: { effort: null } })
    expect((await current()).confirmed ?? []).not.toContain('effort')

    await refresh({ applied: { effort: 'high' } })
    expect((await current()).confirmed).toContain('effort')
    let releaseRead!: (value: unknown) => void
    session.connection.getSettings = () =>
      new Promise((resolve) => {
        releaseRead = resolve
      })
    const lateRead = refreshClaudeStructuredSessionOptions(
      session,
      undefined,
      () => true,
      () => {}
    )
    await expect(
      setClaudeStructuredOption(session, { key: 'effort', value: 'max' }, undefined)
    ).resolves.toMatchObject({ effort: 'max' })
    expect((await current()).effort).toBe('max')
    expect((await current()).confirmed ?? []).not.toContain('effort')
    releaseRead({ applied: { effort: 'max' } })
    await lateRead
    expect((await current()).effort).toBe('max')
    expect(session.appliedInputOptions.get('effort')).toBe('max')
    expect((await current()).confirmed ?? []).not.toContain('effort')
    expect(calls).toEqual(['apply:high', 'apply:max'])
  })
})
