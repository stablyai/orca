import { describe, expect, it } from 'vitest'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import {
  restoreClaudeStructuredSessionOptions,
  setClaudeStructuredOption
} from './claude-structured-options'
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
    session: {
      options: new Map<string, string>(),
      reportedOptions: {} as { model?: string; effort?: string },
      optionMutationSequence: 0,
      reportedModelMutation: 0,
      confirmedOptions: new Set<string>(),
      restoreSkippedOptions: new Set<string>(),
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
      }
    } as unknown as ClaudeSession,
    calls
  }
}

describe('Claude model pre-flight against the catalog the CLI listed', () => {
  it('refuses a model the provider does not list', async () => {
    const { session, calls } = sessionWith([DEFAULT_ROW, SONNET, HAIKU])

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'not-a-real-model-xyz' }, undefined)
    ).rejects.toBeInstanceOf(AgentSessionOptionRejectedError)
    // Measured on Claude Code 2.1.260: set_model resolves for an unlisted id and
    // every later turn returns is_error with zero tokens. Nothing undoes the
    // write, so the refusal has to land before it.
    expect(calls).toEqual(['list_models'])
    expect(session.options.has('model')).toBe(false)
  })

  it('refuses an unlisted model replayed by restore, and skips it', async () => {
    // Needs no user error: a model valid when it was persisted can be retired.
    const { session, calls } = sessionWith([DEFAULT_ROW, SONNET])
    session.options.set('model', 'claude-opus-4-retired')

    await restoreClaudeStructuredSessionOptions(session, undefined)

    expect(calls).toEqual(['list_models'])
    expect(session.options.has('model')).toBe(false)
    expect([...session.restoreSkippedOptions]).toEqual(['model'])
  })

  it('applies a model the provider lists', async () => {
    const { session, calls } = sessionWith([DEFAULT_ROW, SONNET, HAIKU])

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'haiku' }, undefined)
    ).resolves.toEqual({ model: 'haiku' })
    expect(calls).toEqual(['list_models', 'set_model:haiku'])
  })

  it('applies a resolved model id the catalog carries only under its alias', async () => {
    const { session, calls } = sessionWith([DEFAULT_ROW, SONNET])

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'claude-sonnet-5' }, undefined)
    ).resolves.toEqual({ model: 'claude-sonnet-5' })
    expect(calls).toEqual(['list_models', 'set_model:claude-sonnet-5'])
  })

  it('refuses nothing when list_models is unavailable', async () => {
    // A CLI predating list_models would otherwise have every model refused, and
    // restore swallows the rejection, so the user's pick would vanish silently.
    const { session, calls } = sessionWith('unavailable')

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'sonnet' }, undefined)
    ).resolves.toEqual({ model: 'sonnet' })
    expect(calls).toEqual(['list_models', 'set_model:sonnet'])
  })

  it('refuses nothing when the listed catalog is empty', async () => {
    // An empty answer identifies no model, so it is not evidence against one.
    const { session, calls } = sessionWith([])

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'sonnet' }, undefined)
    ).resolves.toEqual({ model: 'sonnet' })
    expect(calls).toEqual(['list_models', 'set_model:sonnet'])
  })

  it('refuses nothing when the catalog carries only the synthetic default row', async () => {
    // listedModels drops that row, leaving a list that identifies no model.
    const { session, calls } = sessionWith([DEFAULT_ROW])

    await expect(
      setClaudeStructuredOption(session, { key: 'model', value: 'sonnet' }, undefined)
    ).resolves.toEqual({ model: 'sonnet' })
    expect(calls).toEqual(['list_models', 'set_model:sonnet'])
  })

  it('leaves a restored model the provider lists in place', async () => {
    const { session, calls } = sessionWith([DEFAULT_ROW, SONNET])
    session.options.set('model', 'sonnet')

    await restoreClaudeStructuredSessionOptions(session, undefined)

    expect(calls).toEqual(['list_models', 'set_model:sonnet'])
    expect(session.options.get('model')).toBe('sonnet')
    expect([...session.restoreSkippedOptions]).toEqual([])
  })
})
