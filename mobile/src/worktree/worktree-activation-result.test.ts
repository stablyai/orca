import { describe, expect, it } from 'vitest'
import { headlessActivationNeedsHostRenderer } from './worktree-activation-result'

describe('headlessActivationNeedsHostRenderer', () => {
  it('only reports the explicit sleeping-agent headless outcome', () => {
    expect(headlessActivationNeedsHostRenderer({ sleepingAgentWake: 'unsupported-headless' })).toBe(
      true
    )
    expect(headlessActivationNeedsHostRenderer({ sleepingAgentWake: 'not-applicable' })).toBe(false)
    expect(headlessActivationNeedsHostRenderer({ sleepingAgentWake: 'requested' })).toBe(false)
    expect(headlessActivationNeedsHostRenderer(null)).toBe(false)
  })
})
