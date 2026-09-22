import { describe, expect, it } from 'vitest'
import { getInteractiveAgentStartupTimeoutMs } from './worker-topology'

describe('interactive worker startup timeout', () => {
  it('allows ZCode to finish cold provider discovery', () => {
    expect(getInteractiveAgentStartupTimeoutMs('zcode')).toBe(90_000)
  })

  it('keeps the existing startup budget for other agents', () => {
    expect(getInteractiveAgentStartupTimeoutMs('codex')).toBe(30_000)
    expect(getInteractiveAgentStartupTimeoutMs('claude')).toBe(30_000)
  })
})
