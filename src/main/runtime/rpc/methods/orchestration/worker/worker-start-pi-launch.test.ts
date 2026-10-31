import { describe, expect, it } from 'vitest'
import { resolveAgentSessionOptionLaunch } from '../../../../../../shared/agent-session/options/agent-session-option-launch'
import { resolveWorkerLaunchPreferences } from './worker-launch-preferences'

describe('Pi worker-start launch preferences', () => {
  it('passes a provider/id model and thinking level through the shared catalog', () => {
    const model = 'anthropic/claude-sonnet-4-5'
    const launch = resolveWorkerLaunchPreferences({ agent: 'pi', model, effort: 'low' })
    expect(launch).toEqual({
      preferences: { model, effort: 'low' },
      receipt: {
        requested: { agent: 'pi', model, effort: 'low' },
        effective: { agent: 'pi', model, effort: 'low' }
      }
    })
    expect(resolveAgentSessionOptionLaunch('pi', launch.preferences, [], false).args).toEqual([
      '--model',
      model,
      '--thinking',
      'low'
    ])
  })

  it('leaves Pi on its own configuration when no model or effort is requested', () => {
    expect(resolveWorkerLaunchPreferences({ agent: 'pi' })).toEqual({
      preferences: undefined,
      receipt: {
        requested: { agent: 'pi', model: null, effort: null },
        effective: { agent: 'pi', model: null, effort: null }
      }
    })
  })

  it('rejects a Pi effort outside its thinking levels', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'pi',
        model: 'anthropic/claude-sonnet-4-5',
        effort: 'turbo'
      })
    ).toThrow('does not support effort turbo')
  })
})
