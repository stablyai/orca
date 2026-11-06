import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { logHostedCliDeadlineKill } from './hosted-cli-deadline-log'

// A resolved path identifies recursive wrappers without logging secret-bearing arguments.
describe('hosted CLI deadline logging', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names the CLI, the deadline and the resolved path, and never the argv values', () => {
    logHostedCliDeadlineKill(
      'gh',
      '/home/user/.local/bin/gh',
      ['api', '-H', 'Authorization: token ghp_secret'],
      15_000
    )

    const line = warn.mock.calls[0][0] as string
    expect(line).toContain('[gh]')
    expect(line).toContain('15000ms')
    expect(line).toContain('/home/user/.local/bin/gh')
    expect(line).toContain('"api"')
    expect(line).toContain('(3 args)')
    expect(line).not.toContain('ghp_secret')
    expect(line).not.toContain('Authorization')
  })
})
