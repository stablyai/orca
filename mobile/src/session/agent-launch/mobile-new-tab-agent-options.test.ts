import { describe, expect, it } from 'vitest'

import { orderMobileNewTabAgents } from './mobile-new-tab-agent-options'

describe('mobile new-tab agent options', () => {
  it('orders the enabled detected default first', () => {
    expect(orderMobileNewTabAgents('codex', ['gemini', 'codex', 'claude'], ['gemini'])).toEqual([
      'codex',
      'claude'
    ])
  })
})
