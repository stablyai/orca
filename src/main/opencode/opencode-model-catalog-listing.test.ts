import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseOpenCodeModelListing } from './opencode-model-catalog-listing'
import { structuredAgentSessionSeedCatalog } from '../../shared/agent-session/options/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  commitStructuredAgentSessionOption,
  createStructuredAgentSessionOptionState
} from '../../shared/agent-session/options/structured-agent-session-options'
import {
  structuredAgentSessionMessageSelection,
  structuredAgentSessionSendSelection
} from '../../shared/agent-session/options/structured-agent-session-option-view'
import { buildNativeChatSessionOptionSnapshot } from '../../shared/native-chat/input/native-chat-session-option-snapshot'
import { resolveAgentSessionOptionLaunch } from '../../shared/agent-session/options/agent-session-option-launch'

// Match opencode models --verbose: ID followed by pretty-printed model JSON.
function listing(models: Record<string, unknown>): string {
  return Object.entries(models)
    .map(([id, model]) => `${id}\n${JSON.stringify(model, null, 2)}\n`)
    .join('')
}

describe('OpenCode verbose model listing', () => {
  it('declares the variant a recorded 1.x listing runs, shown but never sent', () => {
    // OpenCode 1.18.31 models --verbose capture, 2026-10-30; one complete model row.
    const stdout = readFileSync(
      new URL('../acp/fixtures/opencode-v1-model-listing.txt', import.meta.url),
      'utf8'
    )
    const models = parseOpenCodeModelListing(stdout)
    const model = models[0]!
    expect(model?.efforts.map(({ value }) => value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'default'
    ])
    // OpenCode 1.x ACP runs the first listed variant when none is literally named default.
    expect(model).toMatchObject({ defaultEffort: 'low', declaredDefaultEffort: 'low' })

    const seed = structuredAgentSessionSeedCatalog('opencode')
    const listed = applyStructuredAgentSessionModelCatalog(
      createStructuredAgentSessionOptionState('opencode', seed),
      seed,
      { origin: 'probe', models, fetchedAt: 1, listingNamesConfiguredModel: false },
      { newLaunch: true }
    )
    const pickedModel = commitStructuredAgentSessionOption(listed, 'model', model.id)
    const catalog = pickedModel.catalog!
    const draft = buildNativeChatSessionOptionSnapshot({
      catalog,
      models: catalog.models,
      record: {
        agent: 'opencode',
        model: { value: model.id, source: 'dispatched' },
        valuesByModel: {}
      },
      mode: 'draft',
      modelLabel: 'Model',
      liveTransport: 'agent-session'
    })
    expect(draft.find(({ id }) => id === 'effort')).toMatchObject({
      valueSource: 'default',
      kind: { currentValue: 'low' }
    })
    // Shown, never sent: OpenCode picks the same variant itself.
    expect(structuredAgentSessionMessageSelection(pickedModel)).toEqual({ model: model.id })
    expect(structuredAgentSessionSendSelection(pickedModel)).toBeUndefined()
    expect(resolveAgentSessionOptionLaunch('opencode', { model: model.id })).toEqual({
      args: ['--model', model.id],
      appliedValues: { model: model.id }
    })
  })

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
        defaultEffort: 'high',
        declaredDefaultEffort: 'high',
        isDefault: false,
        efforts: [
          { value: 'high', label: 'High' },
          { value: 'max', label: 'Max' },
          { value: 'default', label: 'Default' }
        ]
      },
      {
        id: 'opencode/grok-code',
        label: 'opencode/Grok Code',
        isDefault: false,
        efforts: [
          { value: 'default', label: 'Default' },
          { value: 'fast', label: 'Fast' }
        ],
        defaultEffort: 'default',
        declaredDefaultEffort: 'default'
      },
      {
        id: 'openai/gpt-plain',
        label: 'openai/GPT Plain',
        isDefault: false,
        declaredDefaultEffort: null,
        efforts: []
      }
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
      {
        id: 'openai/gpt-broken',
        label: 'openai/gpt-broken',
        isDefault: false,
        declaredDefaultEffort: null,
        efforts: []
      },
      {
        id: 'openai/gpt-next',
        label: 'openai/gpt-next',
        isDefault: false,
        declaredDefaultEffort: null,
        efforts: []
      }
    ])
  })
})
