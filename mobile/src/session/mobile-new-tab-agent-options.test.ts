import { describe, expect, it } from 'vitest'

import {
  buildMobileNewTabAgentOptions,
  orderMobileNewTabAgents
} from './mobile-new-tab-agent-options'

describe('mobile new-tab agent options', () => {
  it('orders the enabled detected default first', () => {
    expect(orderMobileNewTabAgents('codex', ['gemini', 'codex', 'claude'], ['gemini'])).toEqual([
      'codex',
      'claude'
    ])
  })

  it('returns labeled options for enabled detected agents only', () => {
    expect(
      buildMobileNewTabAgentOptions({ defaultTuiAgent: null, disabledTuiAgents: ['claude'] }, [
        'claude',
        'codex',
        'not-real'
      ])
    ).toEqual([{ agent: 'codex', label: 'Codex' }])
  })

  it('does not show stale presets while detection is pending', () => {
    expect(buildMobileNewTabAgentOptions({ defaultTuiAgent: 'codex' }, null)).toEqual([])
  })
})
