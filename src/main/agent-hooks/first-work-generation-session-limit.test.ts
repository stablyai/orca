import { afterEach, describe, expect, it, vi } from 'vitest'
import { getFirstWorkGenerationSessionLimitRetryAt } from './first-work-generation-session-limit'

describe('getFirstWorkGenerationSessionLimitRetryAt', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the reset carried by a Claude session-limit response', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T09:00:00Z'))

    expect(
      getFirstWorkGenerationSessionLimitRetryAt({
        error: 'Claude CLI exited with code 1.',
        failureOutput: {
          label: 'Claude',
          exitCode: 1,
          stdout: "You've hit your session limit\nResets in 2h",
          stderr: ''
        }
      })
    ).toBe(Date.now() + 2 * 60 * 60_000)
  })

  it('recognizes the time-only response reported in issue 9705', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T10:00:00.000Z'))

    const retryAt = getFirstWorkGenerationSessionLimitRetryAt({
      error: 'Claude CLI exited with code 1.',
      failureOutput: {
        label: 'Claude',
        exitCode: 1,
        stdout: 'hit your session limit · resets 2pm (Europe/Madrid)',
        stderr: ''
      }
    })

    expect(retryAt).toBe(Date.parse('2026-07-21T12:00:00.000Z'))
  })

  it('falls back to a bounded cooldown when the reset is missing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-21T09:00:00Z'))

    expect(
      getFirstWorkGenerationSessionLimitRetryAt({
        error: 'You have hit your session limit.',
        failureOutput: undefined
      })
    ).toBe(Date.now() + 15 * 60_000)
  })

  it('leaves ordinary generation failures on the immediate retry path', () => {
    expect(
      getFirstWorkGenerationSessionLimitRetryAt({
        error: 'Claude CLI is temporarily unavailable.',
        failureOutput: undefined
      })
    ).toBeNull()
  })
})
