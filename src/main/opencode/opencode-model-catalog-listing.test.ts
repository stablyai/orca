import { describe, expect, it } from 'vitest'
import { parseOpenCodeModelListing } from './opencode-model-catalog-listing'

// What `opencode models --verbose` prints: each id, then `JSON.stringify(model, null, 2)`.
function listing(models: Record<string, unknown>): string {
  return Object.entries(models)
    .map(([id, model]) => `${id}\n${JSON.stringify(model, null, 2)}\n`)
    .join('')
}

describe('OpenCode verbose model listing', () => {
  it('reads every model and its variants through multiline metadata', () => {
    const stdout = listing({
      'anthropic/claude-sonnet': {
        id: 'claude-sonnet',
        providerID: 'anthropic',
        name: 'Claude Sonnet',
        cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
        options: { nested: { '}': '{' } },
        variants: { high: { thinking: { budget: 16000 } }, max: { thinking: { budget: 32000 } } }
      },
      'opencode/grok-code': {
        id: 'grok-code',
        name: 'Grok Code',
        variants: { default: {}, fast: {} }
      },
      'openai/gpt-plain': { id: 'gpt-plain', name: 'GPT Plain' }
    })
    expect(parseOpenCodeModelListing(stdout)).toEqual([
      {
        id: 'anthropic/claude-sonnet',
        label: 'anthropic/Claude Sonnet',
        isDefault: false,
        efforts: [
          { value: 'high', label: 'High' },
          { value: 'max', label: 'Max' },
          { value: 'default', label: 'Default' }
        ],
        // No `default` variant: a new session runs the first one, as OpenCode's own ACP does.
        defaultEffort: 'high'
      },
      {
        id: 'opencode/grok-code',
        label: 'opencode/Grok Code',
        isDefault: false,
        efforts: [
          { value: 'default', label: 'Default' },
          { value: 'fast', label: 'Fast' }
        ],
        defaultEffort: 'default'
      },
      { id: 'openai/gpt-plain', label: 'openai/GPT Plain', isDefault: false, efforts: [] }
    ])
  })

  it('reads the plain listing, CRLF endings and an empty object, and skips stray lines', () => {
    const stdout = [
      'Models cache refreshed',
      'openai/gpt-a',
      'openai/gpt-b',
      '{}',
      'openai/gpt-c',
      '{',
      '  "name": "GPT C"',
      '}',
      ''
    ].join('\r\n')
    expect(parseOpenCodeModelListing(stdout).map((model) => [model.id, model.label])).toEqual([
      ['openai/gpt-a', 'openai/gpt-a'],
      ['openai/gpt-b', 'openai/gpt-b'],
      ['openai/gpt-c', 'openai/GPT C']
    ])
  })

  it('keeps a model whose metadata does not parse, with no effort menu', () => {
    const stdout = 'openai/gpt-broken\n{\n  "name": \n}\nopenai/gpt-next\n'
    expect(parseOpenCodeModelListing(stdout)).toEqual([
      { id: 'openai/gpt-broken', label: 'openai/gpt-broken', isDefault: false, efforts: [] },
      { id: 'openai/gpt-next', label: 'openai/gpt-next', isDefault: false, efforts: [] }
    ])
  })
})
