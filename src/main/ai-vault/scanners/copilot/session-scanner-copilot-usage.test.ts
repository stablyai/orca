import { expect, it } from 'vitest'
import { createCopilotSessionResumeState } from './session-scanner-copilot-parser'

it('counts model input and output once without adding context or cache subsets', async () => {
  const state = createCopilotSessionResumeState({
    path: '/tmp/copilot-session/events.jsonl',
    mtimeMs: 1784109600000,
    modifiedAt: '2026-07-15T10:00:00.000Z'
  })
  state.consumeLine(JSON.stringify({ type: 'user.message', data: { content: 'Hello' } }))
  state.consumeLine(
    JSON.stringify({
      type: 'session.shutdown',
      data: {
        currentTokens: 27176,
        modelMetrics: {
          'claude-sonnet-5': {
            usage: {
              inputTokens: 71282,
              outputTokens: 345,
              cacheReadTokens: 35495,
              cacheWriteTokens: 35783,
              reasoningTokens: 31
            }
          },
          'other-model': { usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } }
        }
      }
    })
  )
  expect((await state.finalize('linux'))?.totalTokens).toBe(71747)
  state.consumeLine(
    JSON.stringify({ type: 'session.shutdown', data: { modelMetrics: {}, currentTokens: 500 } })
  )
  expect((await state.finalize('linux'))?.totalTokens).toBe(71747)
  state.consumeLine(JSON.stringify({ type: 'session.shutdown', data: { currentTokens: 340 } }))
  expect((await state.finalize('linux'))?.totalTokens).toBe(72087)
})
