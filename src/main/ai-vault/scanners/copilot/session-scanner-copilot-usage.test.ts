import { expect, it } from 'vitest'
import { createCopilotSessionResumeState } from './session-scanner-copilot-parser'

function copilotState() {
  const state = createCopilotSessionResumeState({
    path: '/tmp/copilot-session/events.jsonl',
    mtimeMs: 1784109600000,
    modifiedAt: '2026-07-15T10:00:00.000Z'
  })
  state.consumeLine(JSON.stringify({ type: 'user.message', data: { content: 'Hello' } }))
  return state
}

function shutdown(
  modelMetrics: Record<string, unknown>,
  accountingSnapshot?: Record<string, never>
): string {
  return JSON.stringify({
    type: 'session.shutdown',
    data: { currentTokens: 27176, modelMetrics, accountingSnapshot }
  })
}

it('counts shutdown model usage once without adding context or cache subsets', async () => {
  const state = copilotState()
  state.consumeLine(
    shutdown({
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
    })
  )
  expect((await state.finalize('linux'))?.totalTokens).toBe(71747)
})

it('adds per-run shutdowns and replaces only those a later cumulative shutdown repeats', async () => {
  const state = copilotState()
  const resume = JSON.stringify({ type: 'session.resume', data: {} })
  // Older CLIs restart modelMetrics at zero on resume and write no accountingSnapshot.
  state.consumeLine(shutdown({ 'model-a': { usage: { inputTokens: 9000, outputTokens: 60 } } }))
  state.consumeLine(resume)
  const run = { 'model-a': { usage: { inputTokens: 1000, outputTokens: 10 } } }
  state.consumeLine(shutdown(run, {}))
  state.consumeLine(resume)
  // Inferred from observed 1.0.105-1.0.114 sessions: CLIs that write accountingSnapshot restore it
  // on resume, so this shutdown repeats the previous run's usage.
  const cumulativeRun = { ...run, 'model-b': { usage: { inputTokens: 2000, outputTokens: 20 } } }
  state.consumeLine(shutdown(cumulativeRun, {}))
  expect((await state.finalize('linux'))?.totalTokens).toBe(12090)

  // A zero-usage older-CLI shutdown between snapshot runs keeps the cumulative baseline.
  const downgraded = copilotState()
  downgraded.consumeLine(shutdown(run, {}))
  downgraded.consumeLine(resume)
  downgraded.consumeLine(shutdown({}))
  downgraded.consumeLine(resume)
  downgraded.consumeLine(shutdown(cumulativeRun, {}))
  expect((await downgraded.finalize('linux'))?.totalTokens).toBe(3030)
})
