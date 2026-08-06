import { describe, expect, it } from 'vitest'
import { appendCodexResetCleanupWarning } from './codex-reset-cleanup-warning'

describe('appendCodexResetCleanupWarning', () => {
  it('separates a retained-journal warning from the outcome copy', () => {
    expect(appendCodexResetCleanupWarning('Usage refreshed.', 'Retry record retained.')).toBe(
      'Usage refreshed.\n\nRetry record retained.'
    )
  })

  it('leaves outcome copy unchanged without a warning', () => {
    expect(appendCodexResetCleanupWarning('Usage refreshed.', '')).toBe('Usage refreshed.')
  })
})
