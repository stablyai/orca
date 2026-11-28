import { expect, it } from 'vitest'
import { createCodebuddySessionResumeState } from './session-scanner-codebuddy-parser'

it('bounds and normalizes a CodeBuddy title derived from the first prompt', async () => {
  const state = createCodebuddySessionResumeState({
    path: 'codebuddy.jsonl',
    mtimeMs: 1,
    modifiedAt: '2026-01-01T00:00:00.000Z'
  })
  state.consumeLine(
    JSON.stringify({
      type: 'message',
      role: 'user',
      content:
        'Review this module.\n\nExplain why an older queued background write can replace the newest saved state and how to prevent it.'
    })
  )

  expect((await state.finalize('linux'))?.title).toBe(
    'Review this module. Explain why an older queued background write can replace the newest saved...'
  )
})
