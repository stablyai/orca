import { describe, expect, it, vi } from 'vitest'
import {
  applyPiRpcSessionOption,
  parsePiModelOptionId,
  readPiRpcCommands,
  readPiRpcSessionOptions,
  type PiRpcRequester
} from './rpc-options'

function requester(
  answers: Record<string, unknown>
): PiRpcRequester & { request: ReturnType<typeof vi.fn> } {
  return { request: vi.fn(async (command: string) => answers[command]) }
}

describe('Pi RPC session options', () => {
  it('reads provider-qualified models and the reported thinking level', async () => {
    const rpc = requester({
      get_available_models: {
        models: [
          {
            provider: 'openai-codex',
            id: 'gpt-6.1-sol',
            name: 'GPT-6.1 Sol',
            reasoning: true,
            thinkingLevelMap: { off: null, low: 'low', medium: 'medium', high: 'high' }
          },
          { provider: 'other', id: 'gpt-6.1-sol', name: 'Other Sol', reasoning: false }
        ]
      },
      get_state: {
        model: { provider: 'openai-codex', id: 'gpt-6.1-sol' },
        thinkingLevel: 'medium',
        sessionFile: '/sessions/current.jsonl',
        isStreaming: false,
        isCompacting: false
      }
    })
    const result = await readPiRpcSessionOptions(rpc)
    expect(rpc.request.mock.calls.map((call) => call[0])).toEqual([
      'get_available_models',
      'get_state'
    ])
    expect(result.current).toEqual({
      model: 'openai-codex/gpt-6.1-sol',
      effort: 'medium',
      confirmed: ['model', 'effort']
    })
    expect(result.models.map((model) => [model.id, model.isDefault])).toEqual([
      ['openai-codex/gpt-6.1-sol', false],
      ['other/gpt-6.1-sol', false]
    ])
    expect(result.models[0]?.efforts.map((effort) => effort.value)).toEqual([
      'minimal',
      'low',
      'medium',
      'high'
    ])
    expect(result.models[1]?.efforts).toEqual([])
  })

  it('sends both provider and model ID and stores only successful explicit selections', async () => {
    const rpc = requester({ set_model: {}, set_thinking_level: undefined })
    const selected = new Map<string, string>()
    await expect(
      applyPiRpcSessionOption(rpc, selected, 'model', 'openai-codex/gpt-6.1-sol')
    ).resolves.toEqual({ model: 'openai-codex/gpt-6.1-sol' })
    await expect(applyPiRpcSessionOption(rpc, selected, 'effort', 'high')).resolves.toEqual({
      model: 'openai-codex/gpt-6.1-sol',
      effort: 'high'
    })
    expect(rpc.request.mock.calls).toEqual([
      ['set_model', { provider: 'openai-codex', modelId: 'gpt-6.1-sol' }],
      ['set_thinking_level', { level: 'high' }]
    ])
    expect(() => parsePiModelOptionId('openai-codex')).toThrow()
    await expect(applyPiRpcSessionOption(rpc, selected, 'model', '/gpt-6.1-sol')).rejects.toThrow()
    expect(selected.get('model')).toBe('openai-codex/gpt-6.1-sol')
    const rejected = requester({})
    rejected.request.mockRejectedValueOnce(new Error('provider refused model'))
    await expect(
      applyPiRpcSessionOption(rejected, selected, 'model', 'other/new-model')
    ).rejects.toThrow('provider refused model')
    expect(selected.get('model')).toBe('openai-codex/gpt-6.1-sol')
  })

  it('rejects malformed provider data and reports only Pi-listed commands', async () => {
    const malformed = requester({ get_available_models: { models: [{ id: 'missing-provider' }] } })
    await expect(readPiRpcSessionOptions(malformed)).rejects.toThrow()
    const rpc = requester({
      get_commands: {
        commands: [
          { name: 'review', description: 'Review changes', source: 'extension' },
          { name: 'search', source: 'skill' }
        ]
      }
    })
    expect(await readPiRpcCommands(rpc)).toEqual({
      commands: [
        { name: 'review', kind: 'command', description: 'Review changes' },
        { name: 'search', kind: 'skill' }
      ]
    })
  })

  it('handles a signed-out state with no model', async () => {
    const rpc = requester({
      get_available_models: { models: [] },
      get_state: {
        model: null,
        thinkingLevel: 'off',
        sessionFile: '/sessions/current.jsonl',
        isStreaming: false,
        isCompacting: false
      }
    })
    expect((await readPiRpcSessionOptions(rpc)).current).toEqual({
      model: '',
      effort: 'off',
      confirmed: ['effort']
    })
  })

  it('keeps ordinary thinking levels when the map only supplies overrides', async () => {
    const rpc = requester({
      get_available_models: {
        models: [
          {
            provider: 'openai-codex',
            id: 'gpt-5.5',
            reasoning: true,
            thinkingLevelMap: { minimal: 'low', xhigh: 'xhigh' }
          }
        ]
      },
      get_state: { sessionFile: '/sessions/current.jsonl', isStreaming: false, isCompacting: false }
    })
    expect(
      (await readPiRpcSessionOptions(rpc)).models[0]?.efforts.map(({ value }) => value)
    ).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])
  })
})
