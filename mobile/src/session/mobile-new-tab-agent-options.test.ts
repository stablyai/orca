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

  // Why: a host that never sent the setting keeps the opt-out defaults; an explicit [] enables all.
  it('keeps default-disabled agents hidden when the host omits disabledTuiAgents', () => {
    const detected = ['bob', 'codex']
    expect(buildMobileNewTabAgentOptions({ defaultTuiAgent: null }, detected)).toEqual([
      { agent: 'codex', label: 'Codex' }
    ])
    expect(
      buildMobileNewTabAgentOptions({ defaultTuiAgent: null, disabledTuiAgents: [] }, detected)
    ).toEqual([
      { agent: 'codex', label: 'Codex' },
      { agent: 'bob', label: 'IBM Bob' }
    ])
  })
})
