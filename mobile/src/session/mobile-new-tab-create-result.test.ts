import { describe, expect, it } from 'vitest'
import { readMobileNewTabCreatedTerminal } from './mobile-new-tab-create-result'

describe('readMobileNewTabCreatedTerminal', () => {
  it('returns a created terminal tab', () => {
    const tab = { id: 'tab-1', type: 'terminal', title: 'Agent', terminal: 'pty-1' } as const
    expect(readMobileNewTabCreatedTerminal({ tab })).toBe(tab)
  })

  it('surfaces a disabled custom agent from the success-without-tab envelope', () => {
    expect(() =>
      readMobileNewTabCreatedTerminal({
        agentLaunch: {
          status: 'failed',
          failure: { code: 'custom_agent_disabled' }
        }
      })
    ).toThrow("Couldn't start the agent (custom_agent_disabled).")
  })

  it('preserves an admission rejection code', () => {
    expect(() =>
      readMobileNewTabCreatedTerminal({
        agentLaunch: {
          status: 'rejected',
          requestError: { code: 'untrusted_reference' }
        }
      })
    ).toThrow("Couldn't create the terminal (untrusted_reference).")
  })
})
