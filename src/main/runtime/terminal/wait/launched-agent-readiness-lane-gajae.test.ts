import { describe, expect, it } from 'vitest'
import { getLaunchedAgentReadinessLane } from './launched-agent-composer-readiness'

describe('gajae-code readiness lane', () => {
  it('uses tui-idle because no boot capture is recorded', () => {
    expect(getLaunchedAgentReadinessLane('gajae-code')).toBe('tui-idle')
  })
})
