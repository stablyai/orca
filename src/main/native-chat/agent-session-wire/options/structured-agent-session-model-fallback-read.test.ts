import { expect, it } from 'vitest'
import { piOptionRefreshHost } from '../host/testing/structured-agent-session-option-refresh.test-fixture'

it('shows a live fallback only while the saved model is the input it replaced', async () => {
  const host = piOptionRefreshHost()
  host.live = {
    models: host.models,
    current: { model: 'openai/model' },
    modelFallback: { model: 'openai/fallback', requested: 'openai/model' }
  }
  const answer = await host.read()
  expect(answer.current.fallbackModel).toBe('openai/fallback')
  expect(answer).not.toHaveProperty('modelFallback')
  host.record.options.model = 'openai/picked'
  expect((await host.read()).current.fallbackModel).toBeUndefined()
})
