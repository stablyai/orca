import { describe, expect, it, vi } from 'vitest'
import { USER_MESSAGE, acquired, fakeClaude } from '../claude-structured-session-test-support'

/** Verbatim rows from Claude Code 2.1.258's list_models response. */
const CATALOG = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-5[1m]',
    displayName: 'Default (recommended)',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-5',
    displayName: 'Sonnet',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    supportsEffort: false
  }
]

describe('Claude model confirmation', () => {
  it('stops vouching for a confirmed effort once the model changes', async () => {
    const claude = fakeClaude({
      initModel: 'claude-sonnet-5',
      routes: { list_models: () => CATALOG }
    })
    const adapter = await acquired(claude)
    // Start a cycle to obtain the model-confirming init frame.
    await adapter.dispatch({
      sessionId: 'session-1',
      clientMessageId: 'seed-cycle',
      body: USER_MESSAGE,
      fence: 7
    })

    await adapter.setOption({ sessionId: 'session-1', key: 'effort', value: 'high', fence: 7 })
    await vi.waitFor(async () => {
      expect(await adapter.readOptions({ sessionId: 'session-1', fence: 7 })).toMatchObject({
        current: {
          model: 'claude-sonnet-5',
          effort: 'high',
          confirmed: expect.arrayContaining(['model', 'effort'])
        }
      })
    })

    await adapter.setOption({ sessionId: 'session-1', key: 'model', value: 'haiku', fence: 7 })

    const options = await adapter.readOptions({ sessionId: 'session-1', fence: 7 })
    expect(options.current.effort).toBe('high')
    expect(options.current.confirmed).toBeUndefined()
  })
})
