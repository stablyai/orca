import { expect, it } from 'vitest'
import { ThemeStudioRateLimit } from './theme-studio-guards'

it('lets a burst of 30 through per caller, then asks the caller to wait', () => {
  let now = 0
  const limit = new ThemeStudioRateLimit(() => now)
  for (let call = 0; call < 30; call += 1) {
    limit.take('terminal-a')
  }
  expect(() => limit.take('terminal-a')).toThrow(
    expect.objectContaining({
      code: 'rate_limited',
      data: expect.objectContaining({ retryAfterMs: 334 })
    })
  )
  limit.take('terminal-b')
  now = 400
  limit.take('terminal-a')
})
