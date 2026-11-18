import { expect, it } from 'vitest'
import { ANTIGRAVITY_ACP_DIALECT } from './antigravity-dialect'

// Chunks recorded from agy 1.5.10 against a model endpoint answering 502 until retries ran out.
it('reads failed-request retries as retries and the final failure as reply text', () => {
  const retry = ANTIGRAVITY_ACP_DIALECT.providerRetry
  expect(
    retry?.(
      '\n⚠ API error (attempt 2): Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: UNAVAILABLE, Details: []\n'
    )
  ).toBe(
    'Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: UNAVAILABLE, Details: []'
  )
  expect(
    retry?.(
      '\n⚠ agent executor error: generating and executing: Error 502, Message: Bad Gateway: Failed to connect to backend API, Status: UNAVAILABLE, Details: []\n'
    )
  ).toBeUndefined()
})
