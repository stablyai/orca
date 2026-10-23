import { describe, expect, it } from 'vitest'
import { setClaudeStructuredOption } from './claude-structured-options'
import type { ClaudeSession } from './claude-structured-session-state'

/** Verbatim row shapes from Claude Code 2.1.260's list_models response. */
const DEFAULT_ROW = { value: 'default', resolvedModel: 'claude-opus-5', displayName: 'Default' }
const SONNET = { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' }
const HAIKU = {
  value: 'haiku',
  resolvedModel: 'claude-haiku-4-5-20251001',
  displayName: 'Haiku'
}

function sessionWith(catalog: readonly Record<string, unknown>[] | 'unavailable') {
  const calls: string[] = []
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every session member the option paths under test read.
    session: {
      options: new Map<string, string>(),
      reportedOptions: {} as { model?: string; effort?: string },
      optionMutationSequence: 0,
      reportedModelMutation: 0,
      confirmedOptions: new Set<string>(),
      appliedInputOptions: new Map(),
      connection: {
        supportedModels: async () => {
          calls.push('list_models')
          if (catalog === 'unavailable') {
            throw new Error('this CLI predates list_models')
          }
          return [...catalog]
        },
        setModel: async (model: string) => {
          calls.push(`set_model:${model}`)
        }
      },
      startup: { state: 'proven' }
    } as unknown as ClaudeSession,
    calls
  }
}

describe('Claude literal model controls', () => {
  it.each(['opus[1m]', 'claude-sonnet-5'])(
    'passes %s through an incomplete catalog',
    async (model) => {
      const { session, calls } = sessionWith([DEFAULT_ROW, SONNET, HAIKU])
      await expect(
        setClaudeStructuredOption(session, { key: 'model', value: model }, undefined)
      ).resolves.toEqual({ model })
      expect(calls).toEqual([`set_model:${model}`])
      expect(session.appliedInputOptions.get('model')).toBe(model)
    }
  )
})
