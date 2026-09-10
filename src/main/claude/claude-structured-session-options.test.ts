import { describe, expect, it } from 'vitest'
import { readClaudeStructuredSessionOptions } from './claude-structured-session-options'
import type { ClaudeSession } from './claude-structured-session-state'

// `list_models` rows as the CLI reports them: the `default` row carries only the
// resolved id, which is what marks the listed alias that resolves to the same model.
const LISTED_ROWS = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]' },
  {
    value: 'opus[1m]',
    displayName: 'Opus (1M context)',
    resolvedModel: 'claude-opus-5[1m]',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high']
  },
  { value: 'sonnet', displayName: 'Sonnet', resolvedModel: 'claude-sonnet-5' }
]

function optionsSession(reportedModel: string): ClaudeSession {
  return {
    connection: { supportedModels: async () => LISTED_ROWS },
    options: new Map(),
    reportedOptions: { model: reportedModel },
    optionMutationSequence: 0,
    reportedModelMutation: 0,
    confirmedOptions: new Set()
  } as unknown as ClaudeSession
}

describe('readClaudeStructuredSessionOptions', () => {
  it('names the listed alias the init frame’s resolved id belongs to', async () => {
    // The pill shows a picked Opus as `opus[1m]`, not as the resolved id the session
    // reports — the mapping, not a fabricated row, is what keeps that model nameable.
    const options = await readClaudeStructuredSessionOptions(
      optionsSession('claude-opus-5[1m]'),
      undefined
    )

    expect(options.current).toEqual({ model: 'opus[1m]', confirmed: ['model'] })
    expect(options.models).toEqual([
      {
        id: 'opus[1m]',
        label: 'Opus (1M context)',
        isDefault: true,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'high', label: 'High' }
        ]
      },
      { id: 'sonnet', label: 'Sonnet', isDefault: false, efforts: [] }
    ])
  })

  it('reports an unlisted current model without listing it', async () => {
    // Was: a fabricated `{ id: model, label: model, efforts: [] }` row, which offered a
    // raw launch flag (`worker-start --model claude-opus-5`) as if the CLI listed it.
    const options = await readClaudeStructuredSessionOptions(
      optionsSession('claude-opus-5'),
      undefined
    )

    expect(options.current.model).toBe('claude-opus-5')
    expect(options.models.map((model) => model.id)).toEqual(['opus[1m]', 'sonnet'])
  })
})
