import { describe, expect, it } from 'vitest'
import { piRpcSeededLaunch } from './rpc-launch-seeds'

describe('Pi launch seeds', () => {
  it('maps a saved model and effort to the flags Pi starts on', () => {
    expect(piRpcSeededLaunch({ model: 'anthropic/claude-sonnet-4-5', effort: 'low' })).toEqual({
      extraArgs: ['--model', 'anthropic/claude-sonnet-4-5', '--thinking', 'low'],
      launchIntent: { model: 'anthropic/claude-sonnet-4-5', effort: 'low' },
      configuredArgs: []
    })
  })

  it('leaves Pi on its own configuration when the chat saved nothing', () => {
    expect(piRpcSeededLaunch(undefined)).toEqual({
      extraArgs: [],
      launchIntent: {},
      configuredArgs: []
    })
    expect(piRpcSeededLaunch({})).toEqual({ extraArgs: [], launchIntent: {}, configuredArgs: [] })
  })

  it('seeds a thinking level alone, keeping the configured model', () => {
    expect(piRpcSeededLaunch({ effort: 'high' })).toEqual({
      extraArgs: ['--thinking', 'high'],
      launchIntent: { effort: 'high' },
      configuredArgs: []
    })
  })

  it('drops a configured provider and model that would claim the seeded model', () => {
    expect(
      piRpcSeededLaunch({ model: 'anthropic/claude-sonnet-4-5' }, [
        '--provider',
        'openai',
        '--model',
        'gpt-5.5',
        '--no-extensions'
      ])
    ).toEqual({
      extraArgs: ['--model', 'anthropic/claude-sonnet-4-5'],
      launchIntent: { model: 'anthropic/claude-sonnet-4-5' },
      configuredArgs: ['--no-extensions']
    })
  })

  it('keeps a configured provider and model when only a thinking level is seeded', () => {
    expect(
      piRpcSeededLaunch({ effort: 'low' }, ['--provider', 'openai', '--model', 'gpt-5.5'])
    ).toEqual({
      extraArgs: ['--thinking', 'low'],
      launchIntent: { effort: 'low' },
      configuredArgs: ['--provider', 'openai', '--model', 'gpt-5.5']
    })
  })
})
