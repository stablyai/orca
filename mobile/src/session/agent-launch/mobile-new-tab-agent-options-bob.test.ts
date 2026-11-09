import { describe, expect, it } from 'vitest'
import { buildMobileNewTabAgentOptions } from './mobile-new-tab-agent-options'

describe('mobile new-tab agent options', () => {
  // A host that never sent the setting keeps the opt-out defaults; an explicit [] enables all.
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
